// Integration tests for POS order creation (`createPosOrder`). These run
// against the local Docker MariaDB (DATABASE_URL) and WIPE the order / stock /
// product / POS tables between tests, so point them only at a dev database.
//
//   bun test src/services/order-service.test.ts

import "../lib/load-env.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { users } from "../db/schema/auth.ts";
import { customers } from "../db/schema/customers.ts";
import { locations } from "../db/schema/locations.ts";
import { products, productVariants } from "../db/schema/products.ts";
import { stockLocations } from "../db/schema/stock.ts";
import { db } from "../lib/db.ts";
import { createCustomer, setCustomerCreditLimit, setCustomerPrice } from "./customer-service.ts";
import {
  addCustomerSaleItem,
  addCustomerSalePayment,
  cancelCustomerSale,
  changeCustomerSaleCustomer,
  closeCustomerSale,
  createCustomerSale,
  createPosOrder,
  listOrderItems,
  listOrderPayments,
  OrderError,
  type OrderErrorCode,
  voidCustomerSaleItem,
} from "./order-service.ts";
import { closeSession, createPointOfSale, openSession } from "./pos-service.ts";

let userId: string;
let locationId: string;

/** Truncate every domain table touched by these tests. Users are kept. */
async function wipe(): Promise<void> {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of [
    "order_payments",
    "order_items",
    "orders",
    "customer_ledger",
    "customer_prices",
    "customers",
    "stock_movements",
    "stock_locations",
    "product_variants",
    "products",
    "product_categories",
    "pos_sessions",
    "points_of_sale",
    "locations",
  ]) {
    await db.execute(sql.raw(`DELETE FROM \`${t}\``));
  }
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

beforeAll(async () => {
  userId = ulid();
  await db.insert(users).values({
    id: userId,
    username: `test_${userId}`,
    passwordHash: "x",
    name: "Order Test",
  });
});

afterAll(async () => {
  await wipe();
  await db.delete(users).where(eq(users.id, userId));
  // The shared pool is closed once globally — see src/test-setup.ts.
});

beforeEach(async () => {
  await wipe();
  locationId = ulid();
  await db.insert(locations).values({ id: locationId, name: "Warehouse" });
});

// --- Seed helpers ---

/** Open a fresh POS + session; returns the session id. `code` must be unique per test. */
async function seedSession(code: string): Promise<string> {
  const pos = await createPointOfSale({
    locationId,
    code,
    name: "Counter",
    createdByUserId: userId,
  });
  const session = await openSession({
    posId: pos.id,
    openingCashMinor: 0,
    openedByUserId: userId,
  });
  return session.id;
}

/**
 * Create a product + variant. Physical variants get a stock_locations row at
 * `stockQty` (default 100). Returns the variant id.
 */
async function seedVariant(opts?: {
  kind?: "physical" | "service";
  priceMinor?: number;
  costMinor?: number;
  stockQty?: number;
}): Promise<string> {
  const kind = opts?.kind ?? "physical";
  const productId = ulid();
  const variantId = ulid();
  await db.insert(products).values({
    id: productId,
    name: "Widget",
    kind,
    priceMode: "tax_exclusive",
    taxRateBps: 1100,
  });
  await db.insert(productVariants).values({
    id: variantId,
    productId,
    sku: `SKU-${variantId}`,
    priceMinor: opts?.priceMinor ?? 1000,
    costMinor: opts?.costMinor ?? 400,
  });
  if (kind === "physical") {
    await db.insert(stockLocations).values({
      id: ulid(),
      variantId,
      locationId,
      qty: opts?.stockQty ?? 100,
    });
  }
  return variantId;
}

async function expectError(
  code: OrderErrorCode,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(OrderError);
    expect((e as OrderError).code).toBe(code);
    return;
  }
  throw new Error(`expected OrderError ${code}, nothing thrown`);
}

/** Current stock qty for a variant (sum of its stock_locations rows). */
async function stockOf(variantId: string): Promise<number> {
  const rows = await db
    .select()
    .from(stockLocations)
    .where(eq(stockLocations.variantId, variantId));
  return rows.reduce((sum, r) => sum + r.qty, 0);
}

describe("walk-in orders", () => {
  test("creates a fully-paid order, snapshots the line, decrements stock", async () => {
    const sessionId = await seedSession("P1");
    const variantId = await seedVariant({ priceMinor: 1000, stockQty: 100 });

    const order = await createPosOrder({
      posSessionId: sessionId,
      items: [{ variantId, qty: 3 }],
      payments: [{ amountMinor: 3000 }],
      createdByUserId: userId,
    });

    expect(order.totalMinor).toBe(3000);
    expect(order.closedAt).not.toBeNull();
    expect(order.displayNumber).toBe(`P1-${new Date().toISOString().slice(0, 10)}-0001`);

    const items = await listOrderItems(order.id);
    expect(items).toHaveLength(1);
    expect(items[0]!.snapshotPriceMinor).toBe(1000);
    expect(items[0]!.snapshotCostMinor).toBe(400);
    expect(items[0]!.snapshotTaxRateBps).toBe(1100);

    expect(await stockOf(variantId)).toBe(97);
    expect(await listOrderPayments(order.id)).toHaveLength(1);
  });

  test("applies a per-line discount", async () => {
    const sessionId = await seedSession("P1");
    const variantId = await seedVariant({ priceMinor: 1000 });
    const order = await createPosOrder({
      posSessionId: sessionId,
      items: [{ variantId, qty: 2, discountMinor: 500 }],
      payments: [{ amountMinor: 1500 }],
      createdByUserId: userId,
    });
    expect(order.totalMinor).toBe(1500);
  });

  test("rejects an underpaid walk-in order", async () => {
    const sessionId = await seedSession("P1");
    const variantId = await seedVariant({ priceMinor: 1000 });
    await expectError("WALKIN_NOT_FULLY_PAID", () =>
      createPosOrder({
        posSessionId: sessionId,
        items: [{ variantId, qty: 2 }],
        payments: [{ amountMinor: 1000 }],
        createdByUserId: userId,
      }),
    );
  });

  test("rejects an overpaid order", async () => {
    const sessionId = await seedSession("P1");
    const variantId = await seedVariant({ priceMinor: 1000 });
    await expectError("OVERPAID", () =>
      createPosOrder({
        posSessionId: sessionId,
        items: [{ variantId, qty: 1 }],
        payments: [{ amountMinor: 5000 }],
        createdByUserId: userId,
      }),
    );
  });

  test("rejects an empty order", async () => {
    const sessionId = await seedSession("P1");
    await expectError("EMPTY_ORDER", () =>
      createPosOrder({
        posSessionId: sessionId,
        items: [],
        payments: [],
        createdByUserId: userId,
      }),
    );
  });

  test("display numbers increment per POS per day", async () => {
    const sessionId = await seedSession("P1");
    const variantId = await seedVariant({ priceMinor: 1000 });
    const o1 = await createPosOrder({
      posSessionId: sessionId,
      items: [{ variantId, qty: 1 }],
      payments: [{ amountMinor: 1000 }],
      createdByUserId: userId,
    });
    const o2 = await createPosOrder({
      posSessionId: sessionId,
      items: [{ variantId, qty: 1 }],
      payments: [{ amountMinor: 1000 }],
      createdByUserId: userId,
    });
    expect(o1.displayNumber!.endsWith("-0001")).toBe(true);
    expect(o2.displayNumber!.endsWith("-0002")).toBe(true);
  });
});

describe("on-account orders", () => {
  test("unpaid remainder posts a sale_on_account ledger row and grows the balance", async () => {
    const sessionId = await seedSession("P1");
    const variantId = await seedVariant({ priceMinor: 1000 });
    const customer = await createCustomer({ name: "Pak Budi", createdByUserId: userId });

    const order = await createPosOrder({
      posSessionId: sessionId,
      customerId: customer.id,
      items: [{ variantId, qty: 3 }],
      payments: [{ amountMinor: 1000 }],
      createdByUserId: userId,
    });
    expect(order.totalMinor).toBe(3000);

    const refreshed = await db.query.customers.findFirst({
      where: eq(customers.id, customer.id),
    });
    expect(refreshed!.balanceMinor).toBe(2000);
  });

  test("rejects a remainder that breaches the credit limit", async () => {
    const sessionId = await seedSession("P1");
    const variantId = await seedVariant({ priceMinor: 1000 });
    const customer = await createCustomer({ name: "Pak Budi", createdByUserId: userId });
    await setCustomerCreditLimit(customer.id, 1000);

    await expectError("CREDIT_LIMIT_EXCEEDED", () =>
      createPosOrder({
        posSessionId: sessionId,
        customerId: customer.id,
        items: [{ variantId, qty: 3 }],
        payments: [{ amountMinor: 500 }],
        createdByUserId: userId,
      }),
    );
  });

  test("a customer price override wins over the base price", async () => {
    const sessionId = await seedSession("P1");
    const variantId = await seedVariant({ priceMinor: 1000 });
    const customer = await createCustomer({ name: "Pak Budi", createdByUserId: userId });
    await setCustomerPrice({ customerId: customer.id, variantId, priceMinor: 750 });

    const order = await createPosOrder({
      posSessionId: sessionId,
      customerId: customer.id,
      items: [{ variantId, qty: 2 }],
      payments: [{ amountMinor: 1500 }],
      createdByUserId: userId,
    });
    expect(order.totalMinor).toBe(1500);
  });
});

describe("service products", () => {
  test("a service line skips stock and snapshots a zero cost", async () => {
    const sessionId = await seedSession("P1");
    const variantId = await seedVariant({ kind: "service", priceMinor: 5000, costMinor: 0 });

    const order = await createPosOrder({
      posSessionId: sessionId,
      items: [{ variantId, qty: 1, priceOverrideMinor: 8000 }],
      payments: [{ amountMinor: 8000 }],
      createdByUserId: userId,
    });
    expect(order.totalMinor).toBe(8000);

    const items = await listOrderItems(order.id);
    expect(items[0]!.snapshotPriceMinor).toBe(8000);
    expect(items[0]!.snapshotCostMinor).toBe(0);
  });

  test("rejects a price override on a physical line", async () => {
    const sessionId = await seedSession("P1");
    const variantId = await seedVariant({ kind: "physical", priceMinor: 1000 });
    await expectError("PRICE_OVERRIDE_NOT_ALLOWED", () =>
      createPosOrder({
        posSessionId: sessionId,
        items: [{ variantId, qty: 1, priceOverrideMinor: 800 }],
        payments: [{ amountMinor: 800 }],
        createdByUserId: userId,
      }),
    );
  });
});

describe("session guard", () => {
  test("rejects an order against a closed session", async () => {
    const sessionId = await seedSession("P1");
    await closeSession({ sessionId, closingCashMinor: 0, closedByUserId: userId });
    const variantId = await seedVariant({ priceMinor: 1000 });
    await expectError("SESSION_CLOSED", () =>
      createPosOrder({
        posSessionId: sessionId,
        items: [{ variantId, qty: 1 }],
        payments: [{ amountMinor: 1000 }],
        createdByUserId: userId,
      }),
    );
  });
});

/** Current cached balance for a customer. */
async function balanceOf(customerId: string): Promise<number> {
  const row = await db.query.customers.findFirst({
    where: eq(customers.id, customerId),
  });
  return row!.balanceMinor;
}

describe("console customer sales", () => {
  test("createCustomerSale opens an empty order", async () => {
    const customer = await createCustomer({ name: "Pak Budi", createdByUserId: userId });
    const order = await createCustomerSale({
      customerId: customer.id,
      createdByUserId: userId,
    });
    expect(order.closedAt).toBeNull();
    expect(order.displayNumber).toBeNull();
    expect(order.totalMinor).toBe(0);
  });

  test("adding an item grows the total, the balance, and decrements stock", async () => {
    const customer = await createCustomer({ name: "Pak Budi", createdByUserId: userId });
    const variantId = await seedVariant({ priceMinor: 1000, stockQty: 100 });
    const sale = await createCustomerSale({
      customerId: customer.id,
      createdByUserId: userId,
    });
    const updated = await addCustomerSaleItem({
      orderId: sale.id,
      item: { variantId, qty: 3 },
      createdByUserId: userId,
    });
    expect(updated.totalMinor).toBe(3000);
    expect(await balanceOf(customer.id)).toBe(3000);
    expect(await stockOf(variantId)).toBe(97);
  });

  test("voiding an item reverses the total, balance, and stock", async () => {
    const customer = await createCustomer({ name: "Pak Budi", createdByUserId: userId });
    const variantId = await seedVariant({ priceMinor: 1000, stockQty: 100 });
    const sale = await createCustomerSale({
      customerId: customer.id,
      createdByUserId: userId,
    });
    await addCustomerSaleItem({
      orderId: sale.id,
      item: { variantId, qty: 3 },
      createdByUserId: userId,
    });
    const itemId = (await listOrderItems(sale.id))[0]!.id;
    const after = await voidCustomerSaleItem({
      orderItemId: itemId,
      reason: "wrong item",
      voidedByUserId: userId,
    });
    expect(after.totalMinor).toBe(0);
    expect(await balanceOf(customer.id)).toBe(0);
    expect(await stockOf(variantId)).toBe(100);
  });

  test("a payment reduces the customer balance", async () => {
    const customer = await createCustomer({ name: "Pak Budi", createdByUserId: userId });
    const variantId = await seedVariant({ priceMinor: 1000 });
    const sale = await createCustomerSale({
      customerId: customer.id,
      createdByUserId: userId,
    });
    await addCustomerSaleItem({
      orderId: sale.id,
      item: { variantId, qty: 5 },
      createdByUserId: userId,
    });
    await addCustomerSalePayment({
      orderId: sale.id,
      amountMinor: 2000,
      createdByUserId: userId,
    });
    expect(await balanceOf(customer.id)).toBe(3000);
  });

  test("closing assigns a C-prefixed display number and locks the order", async () => {
    const customer = await createCustomer({ name: "Pak Budi", createdByUserId: userId });
    const variantId = await seedVariant({ priceMinor: 1000 });
    const sale = await createCustomerSale({
      customerId: customer.id,
      createdByUserId: userId,
    });
    await addCustomerSaleItem({
      orderId: sale.id,
      item: { variantId, qty: 1 },
      createdByUserId: userId,
    });
    const closed = await closeCustomerSale({ orderId: sale.id, closedByUserId: userId });
    expect(closed.closedAt).not.toBeNull();
    expect(closed.displayNumber!.startsWith("C-")).toBe(true);

    await expectError("ORDER_CLOSED", () =>
      addCustomerSaleItem({
        orderId: sale.id,
        item: { variantId, qty: 1 },
        createdByUserId: userId,
      }),
    );
  });

  test("an item add breaching the credit limit is rejected", async () => {
    const customer = await createCustomer({ name: "Pak Budi", createdByUserId: userId });
    await setCustomerCreditLimit(customer.id, 1000);
    const variantId = await seedVariant({ priceMinor: 1000 });
    const sale = await createCustomerSale({
      customerId: customer.id,
      createdByUserId: userId,
    });
    await expectError("CREDIT_LIMIT_EXCEEDED", () =>
      addCustomerSaleItem({
        orderId: sale.id,
        item: { variantId, qty: 3 },
        createdByUserId: userId,
      }),
    );
  });

  test("cancelling voids every line and zeroes the balance", async () => {
    const customer = await createCustomer({ name: "Pak Budi", createdByUserId: userId });
    const variantId = await seedVariant({ priceMinor: 1000, stockQty: 100 });
    const sale = await createCustomerSale({
      customerId: customer.id,
      createdByUserId: userId,
    });
    await addCustomerSaleItem({
      orderId: sale.id,
      item: { variantId, qty: 4 },
      createdByUserId: userId,
    });
    const cancelled = await cancelCustomerSale({
      orderId: sale.id,
      reason: "customer left",
      cancelledByUserId: userId,
    });
    expect(cancelled.cancelledAt).not.toBeNull();
    expect(cancelled.totalMinor).toBe(0);
    expect(await balanceOf(customer.id)).toBe(0);
    expect(await stockOf(variantId)).toBe(100);
  });

  test("changing the customer moves the open sale's debt", async () => {
    const a = await createCustomer({ name: "Customer A", createdByUserId: userId });
    const b = await createCustomer({ name: "Customer B", createdByUserId: userId });
    const variantId = await seedVariant({ priceMinor: 1000 });
    const sale = await createCustomerSale({ customerId: a.id, createdByUserId: userId });
    await addCustomerSaleItem({
      orderId: sale.id,
      item: { variantId, qty: 3 },
      createdByUserId: userId,
    });
    expect(await balanceOf(a.id)).toBe(3000);

    const moved = await changeCustomerSaleCustomer({
      orderId: sale.id,
      newCustomerId: b.id,
      changedByUserId: userId,
    });
    expect(moved.customerId).toBe(b.id);
    expect(await balanceOf(a.id)).toBe(0);
    expect(await balanceOf(b.id)).toBe(3000);
  });
});
