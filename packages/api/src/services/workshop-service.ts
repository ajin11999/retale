// Workshop service: read and edit the single workshop-settings row. The table
// holds at most one row, addressed by a fixed id; `getWorkshopSettings` hands
// back blank defaults before anything is saved, so callers never deal with a
// missing row.

import { eq } from "drizzle-orm";
import { workshopSettings } from "../db/schema/workshop.ts";
import { db } from "../lib/db.ts";

/** The fixed primary key of the one workshop-settings row. */
const SINGLETON_ID = "00000000000000000000000000";

type WorkshopSettings = typeof workshopSettings.$inferSelect;

/** The workshop settings — blank defaults if none have been saved yet. */
export async function getWorkshopSettings(): Promise<WorkshopSettings> {
  const row = await db.query.workshopSettings.findFirst({
    where: eq(workshopSettings.id, SINGLETON_ID),
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

/** Upsert the workshop settings — only the provided fields change. */
export async function updateWorkshopSettings(patch: {
  name?: string;
  phone?: string | null;
  email?: string | null;
  poGreeting?: string | null;
  poFooter?: string | null;
}): Promise<WorkshopSettings> {
  const existing = await db.query.workshopSettings.findFirst({
    where: eq(workshopSettings.id, SINGLETON_ID),
  });

  if (existing) {
    await db
      .update(workshopSettings)
      .set({
        ...(patch.name !== undefined && { name: patch.name.trim() }),
        ...(patch.phone !== undefined && { phone: patch.phone }),
        ...(patch.email !== undefined && { email: patch.email }),
        ...(patch.poGreeting !== undefined && { poGreeting: patch.poGreeting }),
        ...(patch.poFooter !== undefined && { poFooter: patch.poFooter }),
      })
      .where(eq(workshopSettings.id, SINGLETON_ID));
  } else {
    await db.insert(workshopSettings).values({
      id: SINGLETON_ID,
      name: patch.name?.trim() ?? "",
      phone: patch.phone ?? null,
      email: patch.email ?? null,
      poGreeting: patch.poGreeting ?? null,
      poFooter: patch.poFooter ?? null,
    });
  }
  return getWorkshopSettings();
}
