import "../lib/load-env.ts";
import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { like, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db } from "../lib/db.ts";
import { users } from "../db/schema/auth.ts";
import { documentSequences } from "../db/schema/document-sequences.ts";
import { requestForQuotations } from "../db/schema/rfqs.ts";
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
  await db.delete(documentSequences).where(like(documentSequences.prefix, "RFQ-%"));
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

describe("RFQ numbering", () => {
  const date = "2026-11-19";
  beforeEach(() => setSystemTime(new Date("2026-11-19T03:00:00Z")));
  afterEach(() => setSystemTime());

  test("sequential creations get consecutive numbers", async () => {
    const input = { date, createdByUserId: await seedUser() };
    expect((await rfqService.createRfq(input)).rfqNumber).toBe("RFQ-202611-0001");
    expect((await rfqService.createRfq(input)).rfqNumber).toBe("RFQ-202611-0002");
  });

  test("deleting the newest RFQ does not release its number", async () => {
    const input = { date, createdByUserId: await seedUser() };
    const newest = await rfqService.createRfq(input);
    await rfqService.deleteRfq(newest.id);
    expect((await rfqService.createRfq(input)).rfqNumber).toBe("RFQ-202611-0002");
  });

  test("concurrent creations opening a month get distinct numbers", async () => {
    const input = { date, createdByUserId: await seedUser() };
    const rfqs = await Promise.all(Array.from({ length: 3 }, () => rfqService.createRfq(input)));
    expect(rfqs.map(rfq => rfq.rfqNumber).sort()).toEqual([
      "RFQ-202611-0001", "RFQ-202611-0002", "RFQ-202611-0003",
    ]);
  });

  test("the sequence changes month at midnight in Jakarta", async () => {
    const input = { date, createdByUserId: await seedUser() };
    setSystemTime(new Date("2026-11-30T16:59:59Z"));
    expect((await rfqService.createRfq(input)).rfqNumber).toBe("RFQ-202611-0001");
    setSystemTime(new Date("2026-11-30T18:00:00Z"));
    expect((await rfqService.createRfq(input)).rfqNumber).toBe("RFQ-202612-0001");
  });

  test("continues from each month's backfilled numeric maximum", async () => {
    const input = { date, createdByUserId: await seedUser() };
    await db.insert(requestForQuotations).values([
      "RFQ-202610-9999", "RFQ-202610-10000", "RFQ-202611-0024", "RFQ-202611-0025",
    ].map(rfqNumber => ({ ...input, id: ulid(), rfqNumber })));

    const migration = await Bun.file(new URL("../../drizzle/0054_mixed_iron_patriot.sql", import.meta.url)).text();
    const backfill = migration.split("--> statement-breakpoint").find(stmt => stmt.includes("INSERT INTO"));
    if (!backfill) throw new Error("Missing RFQ sequence backfill");
    await db.execute(sql.raw(backfill));

    expect((await rfqService.createRfq(input)).rfqNumber).toBe("RFQ-202611-0026");
    setSystemTime(new Date("2026-10-31T03:00:00Z"));
    expect((await rfqService.createRfq(input)).rfqNumber).toBe("RFQ-202610-10001");
  });
});

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

  test("Adhoc / Walk-in vendor name creation and update", async () => {
    const userId = await seedUser();

    const rfq = await rfqService.createRfq({
      date: "2026-08-04",
      snapshotVendorName: "Tokopedia Official Store",
      createdByUserId: userId,
    });

    expect(rfq.vendorId).toBeNull();
    expect(rfq.snapshotVendorName).toBe("Tokopedia Official Store");

    const updated = await rfqService.updateRfq(rfq.id, {
      snapshotVendorName: "Walk-in Store Glodok",
    });

    expect(updated.vendorId).toBeNull();
    expect(updated.snapshotVendorName).toBe("Walk-in Store Glodok");
  });

  test("importRfqItemsFromRequisition adds PR items with custom estimated costs to existing draft RFQ", async () => {
    const userId = await seedUser();

    const pr = await reqService.createRequisition({
      name: "Office Hardware",
      createdByUserId: userId,
    });
    const prItem1 = await reqService.createItem({
      requisitionId: pr.id,
      description: "Monitor Arm Dual",
      qtyRequested: 3,
      estimatedUnitCostMinor: 450000,
    });
    const prItem2 = await reqService.createItem({
      requisitionId: pr.id,
      description: "Ergonomic Chair",
      qtyRequested: 2,
      estimatedUnitCostMinor: 1200000,
    });

    const rfq = await rfqService.createRfq({
      date: "2026-08-04",
      snapshotVendorName: "Local Hardware Depot",
      createdByUserId: userId,
    });

    const updatedRfq = await rfqService.importRfqItemsFromRequisition({
      rfqId: rfq.id,
      items: [
        {
          requisitionItemId: prItem1.id,
          description: prItem1.description,
          qtyRequested: 3,
          targetUnitCostMinor: 400000, // overridden estimate cost
        },
        {
          requisitionItemId: prItem2.id,
          description: prItem2.description,
          qtyRequested: 2,
          targetUnitCostMinor: 1100000, // overridden estimate cost
        },
      ],
    });

    const items = await rfqService.listItems(updatedRfq.id);
    expect(items).toHaveLength(2);
    expect(items[0]!.description).toBe("Monitor Arm Dual");
    expect(items[0]!.targetUnitCostMinor).toBe(400000);
    expect(items[1]!.description).toBe("Ergonomic Chair");
    expect(items[1]!.targetUnitCostMinor).toBe(1100000);
  });

  test("RFQ Section management, item/section reordering, and PO section conversion", async () => {
    const userId = await seedUser();
    const vendorId = await seedVendor();

    const rfq = await rfqService.createRfq({
      date: "2026-08-10",
      vendorId,
      createdByUserId: userId,
    });

    // 1. Create Sections
    const sec1 = await rfqService.createSection(rfq.id, "Electrical Component");
    const sec2 = await rfqService.createSection(rfq.id, "Mechanical Hardware");

    expect(sec1.name).toBe("Electrical Component");
    expect(sec2.name).toBe("Mechanical Hardware");

    // 2. Rename Section
    const updatedSec1 = await rfqService.updateSection(sec1.id, "Electrical Parts");
    expect(updatedSec1.name).toBe("Electrical Parts");

    // 3. Create items in sections
    const item1 = await rfqService.createItem({
      rfqId: rfq.id,
      sectionId: sec1.id,
      description: "Wire Harness 12V",
      qtyRequested: 10,
      targetUnitCostMinor: 25000,
    });

    const item2 = await rfqService.createItem({
      rfqId: rfq.id,
      sectionId: sec2.id,
      description: "M6 Hex Bolt Stainless",
      qtyRequested: 50,
      targetUnitCostMinor: 1500,
    });

    // 4. Reorder sections
    const reorderedSections = await rfqService.reorderSections(rfq.id, [sec2.id, sec1.id]);
    expect(reorderedSections[0]!.id).toBe(sec2.id);
    expect(reorderedSections[1]!.id).toBe(sec1.id);

    // 5. Reorder items
    const reorderedItems = await rfqService.reorderItems(rfq.id, [item2.id, item1.id]);
    expect(reorderedItems[0]!.id).toBe(item2.id);
    expect(reorderedItems[1]!.id).toBe(item1.id);

    // 6. Test Delete section (items lose sectionId FK set null)
    const sec3 = await rfqService.createSection(rfq.id, "Temp Section");
    const item3 = await rfqService.createItem({
      rfqId: rfq.id,
      sectionId: sec3.id,
      description: "Temp Line Item",
      qtyRequested: 1,
    });
    expect(item3.sectionId).toBe(sec3.id);

    await rfqService.deleteSection(sec3.id);
    const reloadedItem3 = await rfqService.listItems(rfq.id).then((l) => l.find((i) => i.id === item3.id));
    expect(reloadedItem3?.sectionId).toBeNull();

    // 7. Convert RFQ to PO and verify sections are carried over
    const po = await rfqService.convertRfqToPurchase({
      rfqId: rfq.id,
      createdByUserId: userId,
    });

    expect(po.status).toBe("open");
    expect(po.vendorId).toBe(vendorId);

    // Check PO items have non-null sectionId matching created PO sections
    const poItems = await db.query.purchaseItems.findMany({
      where: (t, { eq }) => eq(t.purchaseId, po.id),
    });
    expect(poItems).toHaveLength(3);
    const item1Po = poItems.find((i) => i.description === "Wire Harness 12V");
    const item2Po = poItems.find((i) => i.description === "M6 Hex Bolt Stainless");
    const item3Po = poItems.find((i) => i.description === "Temp Line Item");
    expect(item1Po?.sectionId).not.toBeNull();
    expect(item2Po?.sectionId).not.toBeNull();
    expect(item3Po?.sectionId).toBeNull();
  });
});
