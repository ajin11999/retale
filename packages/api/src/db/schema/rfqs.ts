import { relations } from "drizzle-orm";
import {
  type AnyMySqlColumn,
  bigint,
  date,
  foreignKey,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  text,
  varchar,
} from "drizzle-orm/mysql-core";
import { users } from "./auth.ts";
import { productVariants } from "./products.ts";
import { purchaseRequisitionItems } from "./requisitions.ts";
import { vendors } from "./vendors.ts";
import { money, timestamps, ulidPk, ulidRef } from "./_helpers.ts";

export const RFQ_STATUSES = [
  "draft",
  "sent",
  "received",
  "awarded",
  "cancelled",
] as const;

export const requestForQuotations = mysqlTable("request_for_quotations", {
  id: ulidPk(),
  rfqNumber: varchar({ length: 100 }).notNull(),
  vendorId: ulidRef().references(() => vendors.id, { onDelete: "set null" }),
  snapshotVendorName: varchar({ length: 300 }),
  date: date({ mode: "string" }).notNull(),
  dueDate: date({ mode: "string" }),
  status: mysqlEnum(RFQ_STATUSES).notNull().default("draft"),
  memo: text(),
  termsAndConditions: text(),
  createdByUserId: ulidRef().references(() => users.id),
  ...timestamps,
});

export const rfqSections = mysqlTable(
  "rfq_sections",
  {
    id: ulidPk(),
    rfqId: ulidRef().notNull(),
    name: varchar({ length: 200 }).notNull(),
    sortOrder: int().notNull().default(0),
  },
  (t) => [
    foreignKey({
      name: "rfq_sec_rfq_id_fk",
      columns: [t.rfqId],
      foreignColumns: [requestForQuotations.id],
    }).onDelete("cascade"),
  ]
);

export const rfqItems = mysqlTable(
  "rfq_items",
  {
    id: ulidPk(),
    rfqId: ulidRef().notNull(),
    sectionId: ulidRef(),
    requisitionItemId: ulidRef().references(() => purchaseRequisitionItems.id, {
      onDelete: "set null",
    }),
    variantId: ulidRef().references(() => productVariants.id, {
      onDelete: "set null",
    }),
    description: varchar({ length: 300 }),
    qtyRequested: bigint({ mode: "number" }).notNull(),
    targetUnitCostMinor: money().notNull().default(0),
    quotedUnitCostMinor: money().notNull().default(0),
    sortOrder: int().notNull().default(0),
  },
  (t) => [
    foreignKey({
      name: "rfq_item_rfq_id_fk",
      columns: [t.rfqId],
      foreignColumns: [requestForQuotations.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "rfq_item_sec_id_fk",
      columns: [t.sectionId],
      foreignColumns: [rfqSections.id],
    }).onDelete("set null"),
    index("rfq_items_rfq_id_idx").on(t.rfqId),
    index("rfq_items_variant_id_idx").on(t.variantId),
    index("rfq_items_req_item_id_idx").on(t.requisitionItemId),
  ]
);

export const requestForQuotationsRelations = relations(
  requestForQuotations,
  ({ one, many }) => ({
    vendor: one(vendors, {
      fields: [requestForQuotations.vendorId],
      references: [vendors.id],
    }),
    sections: many(rfqSections),
    items: many(rfqItems),
  })
);

export const rfqSectionsRelations = relations(rfqSections, ({ one, many }) => ({
  rfq: one(requestForQuotations, {
    fields: [rfqSections.rfqId],
    references: [requestForQuotations.id],
  }),
  items: many(rfqItems),
}));

export const rfqItemsRelations = relations(rfqItems, ({ one }) => ({
  rfq: one(requestForQuotations, {
    fields: [rfqItems.rfqId],
    references: [requestForQuotations.id],
  }),
  section: one(rfqSections, {
    fields: [rfqItems.sectionId],
    references: [rfqSections.id],
  }),
  requisitionItem: one(purchaseRequisitionItems, {
    fields: [rfqItems.requisitionItemId],
    references: [purchaseRequisitionItems.id],
  }),
  variant: one(productVariants, {
    fields: [rfqItems.variantId],
    references: [productVariants.id],
  }),
}));
