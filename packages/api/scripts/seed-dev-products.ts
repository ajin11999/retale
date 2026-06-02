// DEV ONLY — seed a small catalog of categories, products, and variants so
// the console has something to show. Idempotent: skips if products exist.
//
//   bun run dev:seed-products

import { eq } from "drizzle-orm";
import {
  productCategories,
  products as productsTable,
} from "../src/db/schema/products.ts";
import { db, pool } from "../src/lib/db.ts";
import * as svc from "../src/services/product-service.ts";

/** Find a category by name, or create it — never duplicates on re-run. */
async function ensureCategory(name: string): Promise<string> {
  const existing = await db
    .select()
    .from(productCategories)
    .where(eq(productCategories.name, name))
    .limit(1);
  if (existing[0]) return existing[0].id;
  const created = await svc.createCategory({ name });
  return created.id;
}

interface SeedProduct {
  name: string;
  priceMode: "tax_inclusive" | "tax_exclusive";
  taxRateBps?: number;
  variants: { label?: string; priceMinor: number; costMinor: number }[];
}

const CATALOG: Record<string, SeedProduct[]> = {
  Fasteners: [
    { name: "Hex Bolt M8", priceMode: "tax_inclusive", variants: [
      { label: "20mm", priceMinor: 1500, costMinor: 900 },
      { label: "40mm", priceMinor: 2200, costMinor: 1300 },
      { label: "60mm", priceMinor: 3000, costMinor: 1800 },
    ] },
    { name: "Wood Screw 4x30", priceMode: "tax_inclusive", variants: [
      { priceMinor: 800, costMinor: 450 },
    ] },
    { name: "Wall Anchor", priceMode: "tax_inclusive", variants: [
      { label: "6mm", priceMinor: 1200, costMinor: 700 },
      { label: "8mm", priceMinor: 1600, costMinor: 950 },
    ] },
  ],
  "Power Tools": [
    { name: "Cordless Drill 18V", priceMode: "tax_exclusive", taxRateBps: 1100, variants: [
      { priceMinor: 875000, costMinor: 620000 },
    ] },
    { name: "Angle Grinder 4\"", priceMode: "tax_exclusive", taxRateBps: 1100, variants: [
      { priceMinor: 540000, costMinor: 390000 },
    ] },
    { name: "Jigsaw 500W", priceMode: "tax_exclusive", taxRateBps: 1100, variants: [
      { priceMinor: 620000, costMinor: 445000 },
    ] },
  ],
  Paint: [
    { name: "Interior Wall Paint", priceMode: "tax_inclusive", variants: [
      { label: "1L White", priceMinor: 68000, costMinor: 44000 },
      { label: "5L White", priceMinor: 295000, costMinor: 205000 },
    ] },
    { name: "Paint Roller Set", priceMode: "tax_inclusive", variants: [
      { priceMinor: 42000, costMinor: 26000 },
    ] },
  ],
  Plumbing: [
    { name: "PVC Pipe 1/2\"", priceMode: "tax_inclusive", variants: [
      { label: "1m", priceMinor: 9500, costMinor: 6000 },
      { label: "4m", priceMinor: 34000, costMinor: 22000 },
    ] },
    { name: "Ball Valve Brass", priceMode: "tax_inclusive", variants: [
      { priceMinor: 47000, costMinor: 31000 },
    ] },
  ],
};

try {
  if ((await db.select().from(productsTable).limit(1)).length > 0) {
    console.log("Products already exist — nothing to do.");
    process.exit(0);
  }

  const creator = await db.query.users.findFirst();
  if (!creator) {
    console.error("No users exist. Bootstrap a root user first.");
    process.exit(1);
  }

  let count = 0;
  for (const [categoryName, items] of Object.entries(CATALOG)) {
    const categoryId = await ensureCategory(categoryName);
    for (const item of items) {
      await svc.createProduct({
        name: item.name,
        kind: "physical",
        categoryId,
        priceMode: item.priceMode,
        taxRateBps: item.taxRateBps ?? 0,
        createdByUserId: creator.id,
        variants: item.variants.map((v, i) => ({
          label: v.label ?? null,
          unit: "piece",
          priceMinor: v.priceMinor,
          costMinor: v.costMinor,
          sortOrder: i + 1,
        })),
      });
      count++;
    }
  }
  console.log(
    `Seeded ${count} products across ${Object.keys(CATALOG).length} categories.`,
  );
} finally {
  await pool.end();
}
