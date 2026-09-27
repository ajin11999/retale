import "../lib/load-env.ts";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db } from "../lib/db.ts";
import { users } from "../db/schema/auth.ts";
import * as reqService from "./requisition-service.ts";

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
    name: "User",
  });
  return id;
}

describe("Requisition Service Tests", () => {
  test("creates, updates, and deletes requisition items", async () => {
    const userId = await seedUser();
    const pr = await reqService.createRequisition({ name: "PR 1", createdByUserId: userId });

    const item1 = await reqService.createItem({
      requisitionId: pr.id,
      description: "Item 1",
      qtyRequested: 10,
    });
    const item2 = await reqService.createItem({
      requisitionId: pr.id,
      description: "Item 2",
      qtyRequested: 20,
    });

    let items = await reqService.listItems(pr.id);
    expect(items.length).toBe(2);

    // Deleting item1 (qtyOrdered === 0) should succeed
    await reqService.deleteItem(item1.id);
    items = await reqService.listItems(pr.id);
    expect(items.length).toBe(1);
    expect(items[0]!.id).toBe(item2.id);
  });

  test("can delete an item that has qtyOrdered > 0", async () => {
    const userId = await seedUser();
    const pr = await reqService.createRequisition({ name: "PR 2", createdByUserId: userId });

    const item = await reqService.createItem({
      requisitionId: pr.id,
      description: "Item with orders",
      qtyRequested: 10,
    });

    // Simulate ordering some quantity
    await db.execute(
      sql`UPDATE purchase_requisition_items SET qty_ordered = 5 WHERE id = ${item.id}`
    );

    // Deleting item with qtyOrdered > 0 should succeed
    await reqService.deleteItem(item.id);
    const items = await reqService.listItems(pr.id);
    expect(items.length).toBe(0);
  });
});
