// Business service: read and edit the single business-settings row. The table
// holds at most one row, addressed by a fixed id; `getBusinessSettings` hands
// back blank defaults before anything is saved, so callers never deal with a
// missing row.

import { rm } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { businessSettings } from "../db/schema/business.ts";
import { db } from "../lib/db.ts";
import { BUSINESS_LOGO_PATH, ensureDir } from "../lib/uploads.ts";

/** The fixed primary key of the one business-settings row. */
const SINGLETON_ID = "00000000000000000000000000";

type BusinessSettings = typeof businessSettings.$inferSelect;

export type BusinessLogoErrorCode =
  | "INVALID_INPUT"
  | "PROCESSING_FAILED"
  | "WRITE_FAILED";

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
 * The stable URL stored for the logo. It is an API-relative path served by the
 * GET /business-logo route; the actual bytes live on local disk at
 * BUSINESS_LOGO_PATH. Callers append a `?v=<updatedAt>` cache-buster.
 */
const LOGO_URL = "/business-logo";

/**
 * Process and store the business logo: orient by EXIF, fit within LOGO_MAX,
 * re-encode to PNG (preserving transparency), write it to local disk, and save
 * the URL. Throws BusinessLogoError on bad input / processing or write failure.
 */
export async function setBusinessLogo(data: Uint8Array): Promise<BusinessSettings> {
  if (data.byteLength === 0) {
    throw new BusinessLogoError("INVALID_INPUT", "image data is empty");
  }

  let png: Buffer;
  try {
    // SVG (and other vector) inputs rasterise at their intrinsic size by
    // default, which is usually far smaller than LOGO_MAX — and we never
    // enlarge a raster. Bump the render density so a vector logo fills the
    // target box crisply; bitmaps are read as-is. Re-encoding to PNG means we
    // never store or serve the SVG itself (no SVG-borne script reaches a
    // browser).
    let pipeline = sharp(data);
    const meta = await pipeline.metadata();
    if (meta.format === "svg") {
      const intrinsic = Math.max(meta.width ?? 0, meta.height ?? 0);
      if (intrinsic > 0) {
        const density = Math.min(2400, Math.max(72, Math.ceil((72 * LOGO_MAX) / intrinsic)));
        pipeline = sharp(data, { density });
      }
    }
    png = await pipeline
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

  try {
    await ensureDir(path.dirname(BUSINESS_LOGO_PATH));
    await Bun.write(BUSINESS_LOGO_PATH, png);
  } catch (e) {
    throw new BusinessLogoError(
      "WRITE_FAILED",
      `could not write logo file: ${(e as Error).message}`,
    );
  }

  await persistLogoUrl(LOGO_URL);
  return getBusinessSettings();
}

/** Remove the business logo: clear the URL and delete the file best-effort. */
export async function clearBusinessLogo(): Promise<BusinessSettings> {
  await persistLogoUrl(null);
  try {
    await rm(BUSINESS_LOGO_PATH, { force: true });
  } catch (e) {
    console.warn(`[business] logo file delete failed: ${(e as Error).message}`);
  }
  return getBusinessSettings();
}
