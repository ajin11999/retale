// Locations service: CRUD, reparenting (with cycle check), archive, and a
// guarded hard delete. The hierarchy is a forest; see docs/design-decisions.md
// → "Locations". Stock-holding checks live here because hard delete must
// refuse to orphan stock.

import { eq, isNull } from "drizzle-orm";
import { ulid } from "ulid";
import { locations } from "../db/schema/locations.ts";
import { stockLocations } from "../db/schema/stock.ts";
import { db } from "../lib/db.ts";

export type LocationErrorCode =
  | "LOCATION_NOT_FOUND"
  | "LOCATION_CYCLE"
  | "HAS_CHILDREN"
  | "HAS_STOCK"
  | "INVALID_INPUT";

export class LocationError extends Error {
  constructor(
    public code: LocationErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "LocationError";
  }
}

type Location = typeof locations.$inferSelect;

export function listLocations(includeArchived = false): Promise<Location[]> {
  return db
    .select()
    .from(locations)
    .where(includeArchived ? undefined : isNull(locations.archivedAt));
}

async function loadLocation(id: string): Promise<Location> {
  const row = await db.query.locations.findFirst({ where: eq(locations.id, id) });
  if (!row) throw new LocationError("LOCATION_NOT_FOUND");
  return row;
}

export { loadLocation as getLocation };

/** Walk the parent chain upward; throw if `parentId` is `id` or a descendant. */
async function assertNoCycle(id: string, parentId: string): Promise<void> {
  let cursor: string | null = parentId;
  while (cursor) {
    if (cursor === id) throw new LocationError("LOCATION_CYCLE");
    const parent: Location = await loadLocation(cursor);
    cursor = parent.parentId;
  }
}

export async function createLocation(input: {
  name: string;
  parentId?: string | null;
  code?: string | null;
  notes?: string | null;
  sortOrder?: number;
  createdByUserId: string;
}): Promise<Location> {
  if (!input.name.trim()) throw new LocationError("INVALID_INPUT", "name is required");
  if (input.parentId) await loadLocation(input.parentId);

  const id = ulid();
  await db.insert(locations).values({
    id,
    name: input.name.trim(),
    parentId: input.parentId ?? null,
    code: input.code ?? null,
    notes: input.notes ?? null,
    sortOrder: input.sortOrder ?? 0,
    createdByUserId: input.createdByUserId,
  });
  return loadLocation(id);
}

export async function updateLocation(
  id: string,
  patch: {
    name?: string;
    parentId?: string | null;
    code?: string | null;
    notes?: string | null;
    sortOrder?: number;
  },
): Promise<Location> {
  await loadLocation(id);
  if (patch.parentId) {
    await loadLocation(patch.parentId);
    await assertNoCycle(id, patch.parentId);
  }

  await db
    .update(locations)
    .set({
      ...(patch.name !== undefined && { name: patch.name.trim() }),
      ...(patch.parentId !== undefined && { parentId: patch.parentId }),
      ...(patch.code !== undefined && { code: patch.code }),
      ...(patch.notes !== undefined && { notes: patch.notes }),
      ...(patch.sortOrder !== undefined && { sortOrder: patch.sortOrder }),
    })
    .where(eq(locations.id, id));
  return loadLocation(id);
}

export async function setLocationArchived(id: string, archived: boolean): Promise<Location> {
  await loadLocation(id);
  await db
    .update(locations)
    .set({ archivedAt: archived ? new Date() : null })
    .where(eq(locations.id, id));
  return loadLocation(id);
}

/**
 * Hard delete. Refused unless the location has no children and holds no
 * stock. Zero-qty `stock_locations` rows are cleared first so the FK does not
 * block the delete. POS / open-session references are checked once those
 * domains exist.
 */
export async function hardDeleteLocation(id: string): Promise<void> {
  await loadLocation(id);

  const child = await db.query.locations.findFirst({
    where: eq(locations.parentId, id),
  });
  if (child) throw new LocationError("HAS_CHILDREN");

  const stockRows = await db
    .select()
    .from(stockLocations)
    .where(eq(stockLocations.locationId, id));
  if (stockRows.some((r) => r.qty !== 0)) throw new LocationError("HAS_STOCK");

  await db.transaction(async (tx) => {
    await tx.delete(stockLocations).where(eq(stockLocations.locationId, id));
    await tx.delete(locations).where(eq(locations.id, id));
  });
}
