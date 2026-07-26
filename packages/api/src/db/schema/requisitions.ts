import { relations } from "drizzle-orm";
import {
  type AnyMySqlColumn,
  bigint,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  varchar,
  foreignKey,
} from "drizzle-orm/mysql-core";
import { users } from "./auth.ts";
import { productVariants } from "./products.ts";
import { timestamps, ulidPk, ulidRef } from "./_helpers.ts";

export const PURCHASE_REQUISITION_STATUSES = [
  "draft",
  "open",
  "partially_ordered",
  "fully_ordered",
  "cancelled",
] as const;

export const purchaseRequisitions = mysqlTable("purchase_requisitions", {
  id: ulidPk(),
  name: varchar({ length: 200 }).notNull(),
  status: mysqlEnum(PURCHASE_REQUISITION_STATUSES).notNull().default("draft"),
  createdByUserId: ulidRef().references(() => users.id),
  ...timestamps,
});

export const purchaseRequisitionSections = mysqlTable("purchase_requisition_sections", {
  id: ulidPk(),
  requisitionId: ulidRef().notNull(),
  name: varchar({ length: 200 }).notNull(),
  sortOrder: int().notNull().default(0),
}, (t) => [
  foreignKey({ name: "prs_req_id_fk", columns: [t.requisitionId], foreignColumns: [purchaseRequisitions.id] }).onDelete("cascade"),
]);

export const purchaseRequisitionItems = mysqlTable(
  "purchase_requisition_items",
  {
    id: ulidPk(),
    requisitionId: ulidRef().notNull(),
    sectionId: ulidRef(),
    variantId: ulidRef().references(() => productVariants.id, { onDelete: "set null" }),
    description: varchar({ length: 300 }),
    qtyRequested: bigint({ mode: "number" }).notNull(),
    qtyOrdered: bigint({ mode: "number" }).notNull().default(0),
    sortOrder: int().notNull().default(0),
  },
  (t) => [
    foreignKey({ name: "pri_req_id_fk", columns: [t.requisitionId], foreignColumns: [purchaseRequisitions.id] }).onDelete("cascade"),
    foreignKey({ name: "pri_sec_id_fk", columns: [t.sectionId], foreignColumns: [purchaseRequisitionSections.id] }).onDelete("set null"),
    index("pr_items_requisition_id_idx").on(t.requisitionId),
    index("pr_items_variant_id_idx").on(t.variantId),
  ],
);

export const purchaseRequisitionsRelations = relations(purchaseRequisitions, ({ many }) => ({
  sections: many(purchaseRequisitionSections),
  items: many(purchaseRequisitionItems),
}));

export const purchaseRequisitionSectionsRelations = relations(purchaseRequisitionSections, ({ one, many }) => ({
  requisition: one(purchaseRequisitions, {
    fields: [purchaseRequisitionSections.requisitionId],
    references: [purchaseRequisitions.id],
  }),
  items: many(purchaseRequisitionItems),
}));

export const purchaseRequisitionItemsRelations = relations(purchaseRequisitionItems, ({ one }) => ({
  requisition: one(purchaseRequisitions, {
    fields: [purchaseRequisitionItems.requisitionId],
    references: [purchaseRequisitions.id],
  }),
  section: one(purchaseRequisitionSections, {
    fields: [purchaseRequisitionItems.sectionId],
    references: [purchaseRequisitionSections.id],
  }),
  variant: one(productVariants, {
    fields: [purchaseRequisitionItems.variantId],
    references: [productVariants.id],
  }),
}));
