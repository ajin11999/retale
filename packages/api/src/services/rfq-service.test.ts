import "../lib/load-env.ts";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db } from "../lib/db.ts";
import { users } from "../db/schema/auth.ts";
import { vendors } from "../db/schema/vendors.ts";
import * as reqService from "./requisition-service.ts";
import * as rfqService from "./rfq-service.ts";

async function wipe(): Promise<void> {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of [
    "purchase_items",
    "purchases",
    "rfq_items",
    "rfq_sections",
    "request_for_quotations",
    "purchase_requisition_items",
    "purchase_requisition_sections",
    "purchase_requisitions",
    "vendors",
    "users",
  ]) {
    await db.execute(sql.raw(`DELETE FROM \`${t}\``));
  }
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
});

async function seedUser(): Promise<string> {
  const id = ulid();
  await db.insert(users).values({
    id,
    username: `user_${id}`,
    passwordHash: "hash",
    name: "Test User",
  });
  return id;
}

async function seedVendor(): Promise<string> {
  const id = ulid();
  await db.insert(vendors).values({
    id,
    name: "Acme Industrial Supplies",
  });
  return id;
}

describe("RFQ & PR Procurement Sandbox Workflow", () => {
  test("PR item budgeting with estimatedUnitCostMinor", async () => {
    const userId = await seedUser();
    const pr = await reqService.createRequisition({
      name: "Warehouse Wishlist #1",
      createdByUserId: userId,
    });

    const item = await reqService.createItem({
      requisitionId: pr.id,
      description: "Hydraulic Pump 2000PSI",
      qtyRequested: 5,
      estimatedUnitCostMinor: 150000, // 1,500.00 estimated
    });

    expect(item.estimatedUnitCostMinor).toBe(150000);
    expect(item.qtyRequested).toBe(5);
    expect(item.qtyOrdered).toBe(0);
  });

  test("Creating RFQ from multiple PRs acts as a sandbox (PR qty remaining unchanged)", async () => {
    const userId = await seedUser();

    // PR 1
    const pr1 = await reqService.createRequisition({
      name: "Department A Wishlist",
      createdByUserId: userId,
    });
    const pr1Item = await reqService.createItem({
      requisitionId: pr1.id,
      description: "Fastener M8 Bolt",
      qtyRequested: 100,
      estimatedUnitCostMinor: 500,
    });

    // PR 2
    const pr2 = await reqService.createRequisition({
      name: "Department B Wishlist",
      createdByUserId: userId,
    });
    const pr2Item = await reqService.createItem({
      requisitionId: pr2.id,
      description: "Steel Washer M8",
      qtyRequested: 200,
      estimatedUnitCostMinor: 100,
    });

    // Create RFQ joining both PR items
    const rfq = await rfqService.createRfqFromRequisitions({
      date: "2026-07-28",
      createdByUserId: userId,
      requisitionItemIds: [pr1Item.id, pr2Item.id],
      memo: "Combined Fasteners Quote Request",
    });

    expect(rfq.status).toBe("draft");

    const rfqItemsList = await rfqService.listItems(rfq.id);
    expect(rfqItemsList).toHaveLength(2);
    expect(rfqItemsList[0]!.targetUnitCostMinor).toBe(500); // Inherited from PR estimatedUnitCostMinor
    expect(rfqItemsList[1]!.targetUnitCostMinor).toBe(100);

    // Verify Sandbox behavior: PR item qtyOrdered is STILL 0 and PR status is draft/open!
    const reloadedPr1Item = (await reqService.getRequisition(pr1.id));
    const pr1Items = await reqService.listItems(pr1.id);
    expect(pr1Items[0]!.qtyOrdered).toBe(0);
    expect(reloadedPr1Item.status).toBe("draft");
  });

  test("Converting awarded RFQ to PO updates PR qtyOrdered and PR status", async () => {
    const userId = await seedUser();
    const vendorId = await seedVendor();

    const pr = await reqService.createRequisition({
      name: "Store Replenishment",
      createdByUserId: userId,
    });
    const prItem = await reqService.createItem({
      requisitionId: pr.id,
      description: "High Performance Oil Filter",
      qtyRequested: 10,
      estimatedUnitCostMinor: 4500,
    });

    const rfq = await rfqService.createRfqFromRequisitions({
      vendorId,
      date: "2026-07-28",
      createdByUserId: userId,
      requisitionItemIds: [prItem.id],
    });

    const [rfqItem] = await rfqService.listItems(rfq.id);

    // Vendor responds with a lower quoted price: 42.00 instead of 45.00
    await rfqService.updateItem(rfqItem!.id, {
      quotedUnitCostMinor: 4200,
    });

    // Convert RFQ to PO
    const po = await rfqService.convertRfqToPurchase({
      rfqId: rfq.id,
      createdByUserId: userId,
    });

    expect(po.status).toBe("open");
    expect(po.vendorId).toBe(vendorId);

    // Verify RFQ is marked as awarded
    const updatedRfq = await rfqService.getRfq(rfq.id);
    expect(updatedRfq.status).toBe("awarded");

    // Verify PR line item qtyOrdered updated to 10 and PR status updated to fully_ordered!
    const updatedPrItems = await reqService.listItems(pr.id);
    expect(updatedPrItems[0]!.qtyOrdered).toBe(10);

    const updatedPr = await reqService.getRequisition(pr.id);
    expect(updatedPr.status).toBe("fully_ordered");
  });
});
