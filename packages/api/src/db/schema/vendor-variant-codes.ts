// Vendor variant codes: the mapping from a vendor's own part number to one of
// our product variants. Two consumers rely on it — the receiving scan resolves
// a vendor's code on a delivery box to the purchase line, and the reorder scan
// uses `isPreferred` to pick the go-to vendor for a variant. Lives in its own
// file because it bridges the vendors and products domains, which must not
// import each other. See docs/future-features.md → "Automating the send PO".

import { relations } from "drizzle-orm";
import { boolean, index, mysqlTable, unique, varchar } from "drizzle-orm/mysql-core";
import { productVariants } from "./products.ts";
import { vendors } from "./vendors.ts";
import { timestamps, ulidPk, ulidRef } from "./_helpers.ts";

/**
 * One vendor's part number for one of our variants. `(vendorId, variantId)` is
 * unique — a vendor names a variant exactly once. `isPreferred` marks the
 * go-to vendor for the variant; at most one preferred row per variant, which
 * the service layer enforces (MariaDB has no partial unique index).
 */
export const vendorVariantCodes = mysqlTable(
  "vendor_variant_codes",
  {
    id: ulidPk(),
    vendorId: ulidRef()
      .notNull()
      .references(() => vendors.id, { onDelete: "cascade" }),
    variantId: ulidRef()
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    // The vendor's catalogue / part number for the variant.
    code: varchar({ length: 100 }).notNull(),
    isPreferred: boolean().notNull().default(false),
    ...timestamps,
  },
  (t) => [
    unique("vendor_variant_codes_vendor_variant_unique").on(t.vendorId, t.variantId),
    index("vendor_variant_codes_variant_id_idx").on(t.variantId),
    index("vendor_variant_codes_code_idx").on(t.code),
  ],
);

export const vendorVariantCodesRelations = relations(vendorVariantCodes, ({ one }) => ({
  vendor: one(vendors, {
    fields: [vendorVariantCodes.vendorId],
    references: [vendors.id],
  }),
  variant: one(productVariants, {
    fields: [vendorVariantCodes.variantId],
    references: [productVariants.id],
  }),
}));
