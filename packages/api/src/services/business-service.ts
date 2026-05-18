// Business service: read and edit the single business-settings row. The table
// holds at most one row, addressed by a fixed id; `getBusinessSettings` hands
// back blank defaults before anything is saved, so callers never deal with a
// missing row.

import { eq } from "drizzle-orm";
import { businessSettings } from "../db/schema/business.ts";
import { db } from "../lib/db.ts";

/** The fixed primary key of the one business-settings row. */
const SINGLETON_ID = "00000000000000000000000000";

type BusinessSettings = typeof businessSettings.$inferSelect;

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
    poGreeting: null,
    poFooter: null,
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
    });
  }
  return getBusinessSettings();
}
