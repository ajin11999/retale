// Business service: read and edit the single business-settings row. The table
// holds at most one row, addressed by a fixed id; `getBusinessSettings` hands
// back blank defaults before anything is saved, so callers never deal with a
// missing row.

import { del, put } from "@vercel/blob";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { ulid } from "ulid";
import { businessSettings } from "../db/schema/business.ts";
import { db } from "../lib/db.ts";

/** The fixed primary key of the one business-settings row. */
const SINGLETON_ID = "00000000000000000000000000";

type BusinessSettings = typeof businessSettings.$inferSelect;

export type BusinessLogoErrorCode =
  | "INVALID_INPUT"
  | "NOT_CONFIGURED"
  | "PROCESSING_FAILED"
  | "UPLOAD_FAILED";

export class BusinessLogoError extends Error {
  constructor(
    public code: BusinessLogoErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "BusinessLogoError";
  }
}

/** Longest edge, in px, of the stored logo. PNG keeps any transparency. */
const LOGO_MAX = 512;

/** The business settings — blank defaults if none have been saved yet. */
export async function getBusinessSettings(): Promise<BusinessSettings> {
  const row = await db.query.businessSettings.findFirst({
    where: eq(businessSettings.id, SINGLETON_ID),
  });
  if (row) return row;
  const now = new Date();
  return {
    id: SINGLETON_ID,
    name: "",
    phone: null,
    email: null,
    logoUrl: null,
    poGreeting: null,
    poFooter: null,
    receiptGreeting: null,
    receiptFooter: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Upsert the business settings — only the provided fields change. */
export async function updateBusinessSettings(patch: {
  name?: string;
  phone?: string | null;
  email?: string | null;
  poGreeting?: string | null;
  poFooter?: string | null;
  receiptGreeting?: string | null;
  receiptFooter?: string | null;
}): Promise<BusinessSettings> {
  const existing = await db.query.businessSettings.findFirst({
    where: eq(businessSettings.id, SINGLETON_ID),
  });

  if (existing) {
    await db
      .update(businessSettings)
      .set({
        ...(patch.name !== undefined && { name: patch.name.trim() }),
        ...(patch.phone !== undefined && { phone: patch.phone }),
        ...(patch.email !== undefined && { email: patch.email }),
        ...(patch.poGreeting !== undefined && { poGreeting: patch.poGreeting }),
        ...(patch.poFooter !== undefined && { poFooter: patch.poFooter }),
        ...(patch.receiptGreeting !== undefined && {
          receiptGreeting: patch.receiptGreeting,
        }),
        ...(patch.receiptFooter !== undefined && {
          receiptFooter: patch.receiptFooter,
        }),
      })
      .where(eq(businessSettings.id, SINGLETON_ID));
  } else {
    await db.insert(businessSettings).values({
      id: SINGLETON_ID,
      name: patch.name?.trim() ?? "",
      phone: patch.phone ?? null,
      email: patch.email ?? null,
      poGreeting: patch.poGreeting ?? null,
      poFooter: patch.poFooter ?? null,
      receiptGreeting: patch.receiptGreeting ?? null,
      receiptFooter: patch.receiptFooter ?? null,
    });
  }
  return getBusinessSettings();
}

/** Write a single logoUrl onto the singleton row, creating it if absent. */
async function persistLogoUrl(logoUrl: string | null): Promise<void> {
  const existing = await db.query.businessSettings.findFirst({
    where: eq(businessSettings.id, SINGLETON_ID),
  });
  if (existing) {
    await db
      .update(businessSettings)
      .set({ logoUrl })
      .where(eq(businessSettings.id, SINGLETON_ID));
  } else {
    await db.insert(businessSettings).values({ id: SINGLETON_ID, logoUrl });
  }
}

/**
 * Process and store the business logo: orient by EXIF, fit within LOGO_MAX,
 * re-encode to PNG (preserving transparency), upload to Blob, and save the
 * URL. The previous logo's blob is removed best-effort. Requires
 * `BLOB_READ_WRITE_TOKEN`. Throws BusinessLogoError on bad input / missing
 * config / processing or upload failure.
 */
export async function setBusinessLogo(data: Uint8Array): Promise<BusinessSettings> {
  if (data.byteLength === 0) {
    throw new BusinessLogoError("INVALID_INPUT", "image data is empty");
  }
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    throw new BusinessLogoError(
      "NOT_CONFIGURED",
      "BLOB_READ_WRITE_TOKEN is not set — cannot store the logo",
    );
  }

  let png: Buffer;
  try {
    png = await sharp(data)
      .rotate()
      .resize({ width: LOGO_MAX, height: LOGO_MAX, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
  } catch (e) {
    throw new BusinessLogoError(
      "PROCESSING_FAILED",
      `could not process logo: ${(e as Error).message}`,
    );
  }

  let url: string;
  try {
    const res = await put(`business/logo-${ulid()}.png`, png, {
      access: "public",
      token,
      contentType: "image/png",
      addRandomSuffix: true,
      cacheControlMaxAge: 31_536_000,
    });
    url = res.url;
  } catch (e) {
    throw new BusinessLogoError(
      "UPLOAD_FAILED",
      `logo upload to blob failed: ${(e as Error).message}`,
    );
  }

  const previous = (await getBusinessSettings()).logoUrl;
  await persistLogoUrl(url);
  if (previous) await delBlobBestEffort(previous, token);
  return getBusinessSettings();
}

/** Remove the business logo: clear the URL and delete its blob best-effort. */
export async function clearBusinessLogo(): Promise<BusinessSettings> {
  const previous = (await getBusinessSettings()).logoUrl;
  await persistLogoUrl(null);
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (previous && token) await delBlobBestEffort(previous, token);
  return getBusinessSettings();
}

async function delBlobBestEffort(url: string, token: string): Promise<void> {
  try {
    await del(url, { token });
  } catch (e) {
    console.warn(`[business] logo blob delete failed: ${(e as Error).message}`);
  }
}
