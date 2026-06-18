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
import { customerLedger, customers } from "../db/schema/customers.ts";
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
  createReturn,
  listOrderItems,
  listOrderPayments,
  listOrdersForReturn,
  OrderError,
  type OrderErrorCode,
  voidCustomerSaleItem,
} from "./order-service.ts";
import {
  closeSession,
  createPointOfSale,
  forceCloseSession,
  openSession,
  reopenSession,
} from "./pos-service.ts";
import { ProductError, setBundleComponents } from "./product-service.ts";
import {
  createTrackingAccount,
  getTrackingAccount,
  listTrackingAccountLedger,
} from "./tracking-service.ts";

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
    "bundle_components",
    "product_variants",
    "products",
    "product_categories",
    "tracking_account_ledger",
    "tracking_accounts",
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
  kind?: "physical" | "service" | "bundle" | "open_price" | "non_stock";
  priceMinor?: number;
  costMinor?: number;
  costRatioBps?: number;
  stockQty?: number;
  priceMode?: "tax_inclusive" | "tax_exclusive";
  taxRateBps?: number;
  trackingAccountId?: string;
  attributionMode?: "full" | "percent";
  attributionPctBps?: number;
  publicName?: string;
}): Promise<string> {
  const kind = opts?.kind ?? "physical";
  const productId = ulid();
  const variantId = ulid();
  await db.insert(products).values({
    id: productId,
    name: "Widget",
    publicName: opts?.publicName ?? null,
    kind,
    costRatioBps: opts?.costRatioBps ?? null,
    priceMode: opts?.priceMode ?? "tax_exclusive",
    taxRateBps: opts?.taxRateBps ?? 1100,
  });
  await db.insert(productVariants).values({
    id: variantId,
    productId,
    sku: `SKU-${variantId}`,
    priceMinor: opts?.priceMinor ?? 1000,
    costMinor: opts?.costMinor ?? 400,
    trackingAccountId: opts?.trackingAccountId ?? null,
    trackingAttributionMode: opts?.attributionMode ?? "full",
    trackingAttributionPctBps: opts?.attributionPctBps ?? null,
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

  test("a price override on a physical line charges the entered price, keeps the cost, moves stock", async () => {
    const sessionId = await seedSession("P1");
    const variantId = await seedVariant({
      kind: "physical",
      priceMinor: 1000,
      costMinor: 400,
      stockQty: 100,
    });

    const order = await createPosOrder({
      posSessionId: sessionId,
      items: [{ variantId, qty: 1, priceOverrideMinor: 800 }],
      payments: [{ amountMinor: 800 }],
      createdByUserId: userId,
    });
    expect(order.totalMinor).toBe(800);

    const items = await listOrderItems(order.id);
    expect(items[0]!.snapshotPriceMinor).toBe(800);
    // Override changes the price, not the cost — margin stays meaningful.
    expect(items[0]!.snapshotCostMinor).toBe(400);
    expect(await stockOf(variantId)).toBe(99);
  });
});

describe("open-price products", () => {
  test("derives cost from the ratio, charges the entered price, skips stock", async () => {
    const sessionId = await seedSession("P1");
    const variantId = await seedVariant({
      kind: "open_price",
      priceMinor: 0,
      costMinor: 0,
      costRatioBps: 6000, // 60%
    });

    const order = await createPosOrder({
      posSessionId: sessionId,
      items: [{ variantId, qty: 1, priceOverrideMinor: 15000 }],
      payments: [{ amountMinor: 15000 }],
      createdByUserId: userId,
    });
    expect(order.totalMinor).toBe(15000);

    const items = await listOrderItems(order.id);
    expect(items[0]!.snapshotPriceMinor).toBe(15000);
    expect(items[0]!.snapshotCostMinor).toBe(9000); // 60% of the entered price
    // An open-price variant has no stock_locations row — nothing moved.
    expect(await stockOf(variantId)).toBe(0);
  });

  test("requires an entered price (no base price to fall back to)", async () => {
    const sessionId = await seedSession("P1");
    const variantId = await seedVariant({ kind: "open_price", costRatioBps: 6000 });
    await expectError("OPEN_PRICE_REQUIRES_PRICE", () =>
      createPosOrder({
        posSessionId: sessionId,
        items: [{ variantId, qty: 1 }],
        payments: [{ amountMinor: 100 }],
        createdByUserId: userId,
      }),
    );
  });
});

describe("non_stock products", () => {
  test("snapshots the real variant cost, charges the base price, skips stock", async () => {
    const sessionId = await seedSession("P1");
    const variantId = await seedVariant({
      kind: "non_stock",
      priceMinor: 5000,
      costMinor: 3200, // a real, known cost (margin protection)
    });

    const order = await createPosOrder({
      posSessionId: sessionId,
      items: [{ variantId, qty: 1 }],
      payments: [{ amountMinor: 5000 }],
      createdByUserId: userId,
    });
    expect(order.totalMinor).toBe(5000); // base price, no override needed

    const items = await listOrderItems(order.id);
    expect(items[0]!.snapshotPriceMinor).toBe(5000);
    // Real cost — not zero (service) and not derived from price (open_price).
    expect(items[0]!.snapshotCostMinor).toBe(3200);
    // non_stock never holds a stock_locations row — nothing moved.
    expect(await stockOf(variantId)).toBe(0);
  });

  test("honours a reseller price override while keeping the real cost", async () => {
    const sessionId = await seedSession("P1");
    const variantId = await seedVariant({
      kind: "non_stock",
      priceMinor: 5000,
      costMinor: 3200,
    });

    const order = await createPosOrder({
      posSessionId: sessionId,
      items: [{ variantId, qty: 1, priceOverrideMinor: 3800 }],
      payments: [{ amountMinor: 3800 }],
      createdByUserId: userId,
    });
    expect(order.totalMinor).toBe(3800);

    const items = await listOrderItems(order.id);
    expect(items[0]!.snapshotPriceMinor).toBe(3800);
    expect(items[0]!.snapshotCostMinor).toBe(3200); // cost unchanged by override
    expect(await stockOf(variantId)).toBe(0);
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

/** Normalize a z_report_json value (MariaDB returns JSON columns as text). */
function parseZ(v: unknown): Record<string, number> {
  return typeof v === "string" ? JSON.parse(v) : (v as Record<string, number>);
}

/** Current cached balance for a customer. */
async function balanceOf(customerId: string): Promise<number> {
  const row = await db.query.customers.findFirst({
    where: eq(customers.id, customerId),
  });
  return row!.balanceMinor;
}

/** All customer_ledger rows for a customer. */
async function ledgerOf(customerId: string) {
  return db
    .select()
    .from(customerLedger)
    .where(eq(customerLedger.customerId, customerId));
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

  test("adding an item grows the total and stock, but not the balance (AR defers to close)", async () => {
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
    // Stock moves live; AR does not — nothing is posted to the ledger yet.
    expect(await balanceOf(customer.id)).toBe(0);
    expect(await ledgerOf(customer.id)).toHaveLength(0);
    expect(await stockOf(variantId)).toBe(97);
  });

  test("voiding an item reverses the total and stock; balance stays zero", async () => {
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
    expect(await ledgerOf(customer.id)).toHaveLength(0);
    expect(await stockOf(variantId)).toBe(100);
  });

  test("a payment on an open sale records order_payments but leaves the balance (AR defers)", async () => {
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
    expect(await balanceOf(customer.id)).toBe(0);
    expect(await ledgerOf(customer.id)).toHaveLength(0);
    const payments = await listOrderPayments(sale.id);
    expect(payments).toHaveLength(1);
    expect(payments[0]!.amountMinor).toBe(2000);
  });

  test("closing posts one sale_on_account for the unpaid remainder", async () => {
    const customer = await createCustomer({ name: "Pak Budi", createdByUserId: userId });
    const variantId = await seedVariant({ priceMinor: 1000 });
    const sale = await createCustomerSale({
      customerId: customer.id,
      createdByUserId: userId,
    });
    await addCustomerSaleItem({
      orderId: sale.id,
      item: { variantId, qty: 3 },
      createdByUserId: userId,
    });
    await addCustomerSalePayment({
      orderId: sale.id,
      amountMinor: 1000,
      createdByUserId: userId,
    });
    // Nothing posted to AR while open.
    expect(await ledgerOf(customer.id)).toHaveLength(0);

    await closeCustomerSale({ orderId: sale.id, closedByUserId: userId });
    const rows = await ledgerOf(customer.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("sale_on_account");
    expect(rows[0]!.amountMinor).toBe(2000);
    expect(await balanceOf(customer.id)).toBe(2000);
  });

  test("closing a fully-paid sale posts no AR row", async () => {
    const customer = await createCustomer({ name: "Pak Budi", createdByUserId: userId });
    const variantId = await seedVariant({ priceMinor: 1000 });
    const sale = await createCustomerSale({
      customerId: customer.id,
      createdByUserId: userId,
    });
    await addCustomerSaleItem({
      orderId: sale.id,
      item: { variantId, qty: 2 },
      createdByUserId: userId,
    });
    await addCustomerSalePayment({
      orderId: sale.id,
      amountMinor: 2000,
      createdByUserId: userId,
    });
    await closeCustomerSale({ orderId: sale.id, closedByUserId: userId });
    expect(await ledgerOf(customer.id)).toHaveLength(0);
    expect(await balanceOf(customer.id)).toBe(0);
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
    // Unpaid at close → the remainder posts as debt.
    expect(await balanceOf(customer.id)).toBe(1000);

    await expectError("ORDER_CLOSED", () =>
      addCustomerSaleItem({
        orderId: sale.id,
        item: { variantId, qty: 1 },
        createdByUserId: userId,
      }),
    );
  });

  test("closing a sale that breaches the credit limit is rejected", async () => {
    const customer = await createCustomer({ name: "Pak Budi", createdByUserId: userId });
    await setCustomerCreditLimit(customer.id, 1000);
    const variantId = await seedVariant({ priceMinor: 1000 });
    const sale = await createCustomerSale({
      customerId: customer.id,
      createdByUserId: userId,
    });
    // Drafting beyond the limit is allowed; the limit only bites at close.
    await addCustomerSaleItem({
      orderId: sale.id,
      item: { variantId, qty: 3 },
      createdByUserId: userId,
    });
    await expectError("CREDIT_LIMIT_EXCEEDED", () =>
      closeCustomerSale({ orderId: sale.id, closedByUserId: userId }),
    );
  });

  test("cancelling voids every line and returns stock; balance stays zero", async () => {
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
    // An open sale never posted AR, so there is nothing to reverse.
    expect(await balanceOf(customer.id)).toBe(0);
    expect(await ledgerOf(customer.id)).toHaveLength(0);
    expect(await stockOf(variantId)).toBe(100);
  });

  test("changing the customer on an open sale relabels it; no balance moves (AR defers)", async () => {
    const a = await createCustomer({ name: "Customer A", createdByUserId: userId });
    const b = await createCustomer({ name: "Customer B", createdByUserId: userId });
    const variantId = await seedVariant({ priceMinor: 1000 });
    const sale = await createCustomerSale({ customerId: a.id, createdByUserId: userId });
    await addCustomerSaleItem({
      orderId: sale.id,
      item: { variantId, qty: 3 },
      createdByUserId: userId,
    });
    expect(await balanceOf(a.id)).toBe(0);

    const moved = await changeCustomerSaleCustomer({
      orderId: sale.id,
      newCustomerId: b.id,
      changedByUserId: userId,
    });
    expect(moved.customerId).toBe(b.id);
    expect(moved.snapshotCustomerName).toBe("Customer B");
    // Neither customer has any ledger movement — the sale relabels only.
    expect(await balanceOf(a.id)).toBe(0);
    expect(await balanceOf(b.id)).toBe(0);
    expect(await ledgerOf(a.id)).toHaveLength(0);
    expect(await ledgerOf(b.id)).toHaveLength(0);
  });
});

describe("returns", () => {
  test("a full cash return links the order, reverses stock, refunds cash", async () => {
    const sessionId = await seedSession("P1");
    const variantId = await seedVariant({ priceMinor: 1000, stockQty: 100 });
    const order = await createPosOrder({
      posSessionId: sessionId,
      items: [{ variantId, qty: 3 }],
      payments: [{ amountMinor: 3000 }],
      createdByUserId: userId,
    });
    const itemId = (await listOrderItems(order.id))[0]!.id;

    const ret = await createReturn({
      originalOrderId: order.id,
      posSessionId: sessionId,
      items: [{ orderItemId: itemId, qty: 3 }],
      refundMethod: "cash",
      createdByUserId: userId,
    });
    expect(ret.returnOfOrderId).toBe(order.id);
    expect(ret.totalMinor).toBe(-3000);
    expect(await stockOf(variantId)).toBe(100);

    const payments = await listOrderPayments(ret.id);
    expect(payments[0]!.amountMinor).toBe(-3000);
  });

  test("partial returns accumulate and over-returning is rejected", async () => {
    const sessionId = await seedSession("P1");
    const variantId = await seedVariant({ priceMinor: 1000, stockQty: 100 });
    const order = await createPosOrder({
      posSessionId: sessionId,
      items: [{ variantId, qty: 3 }],
      payments: [{ amountMinor: 3000 }],
      createdByUserId: userId,
    });
    const itemId = (await listOrderItems(order.id))[0]!.id;

    await createReturn({
      originalOrderId: order.id,
      posSessionId: sessionId,
      items: [{ orderItemId: itemId, qty: 1 }],
      refundMethod: "cash",
      createdByUserId: userId,
    });
    await expectError("RETURN_QTY_EXCEEDED", () =>
      createReturn({
        originalOrderId: order.id,
        posSessionId: sessionId,
        items: [{ orderItemId: itemId, qty: 3 }],
        refundMethod: "cash",
        createdByUserId: userId,
      }),
    );
  });

  test("a store-credit return pays down the customer balance", async () => {
    const sessionId = await seedSession("P1");
    const variantId = await seedVariant({ priceMinor: 1000, stockQty: 100 });
    const customer = await createCustomer({ name: "Pak Budi", createdByUserId: userId });
    const order = await createPosOrder({
      posSessionId: sessionId,
      customerId: customer.id,
      items: [{ variantId, qty: 3 }],
      payments: [{ amountMinor: 1000 }],
      createdByUserId: userId,
    });
    expect(await balanceOf(customer.id)).toBe(2000);
    const itemId = (await listOrderItems(order.id))[0]!.id;

    await createReturn({
      originalOrderId: order.id,
      posSessionId: sessionId,
      items: [{ orderItemId: itemId, qty: 1 }],
      refundMethod: "store_credit",
      createdByUserId: userId,
    });
    expect(await balanceOf(customer.id)).toBe(1000);
  });

  test("store-credit refund on a walk-in order is rejected", async () => {
    const sessionId = await seedSession("P1");
    const variantId = await seedVariant({ priceMinor: 1000, stockQty: 100 });
    const order = await createPosOrder({
      posSessionId: sessionId,
      items: [{ variantId, qty: 1 }],
      payments: [{ amountMinor: 1000 }],
      createdByUserId: userId,
    });
    const itemId = (await listOrderItems(order.id))[0]!.id;
    await expectError("STORE_CREDIT_NEEDS_CUSTOMER", () =>
      createReturn({
        originalOrderId: order.id,
        posSessionId: sessionId,
        items: [{ orderItemId: itemId, qty: 1 }],
        refundMethod: "store_credit",
        createdByUserId: userId,
      }),
    );
  });

  test("z-report folds order cash sales into the variance", async () => {
    const sessionId = await seedSession("P1");
    const variantId = await seedVariant({ priceMinor: 1000, stockQty: 100 });
    await createPosOrder({
      posSessionId: sessionId,
      items: [{ variantId, qty: 3 }],
      payments: [{ amountMinor: 3000 }],
      createdByUserId: userId,
    });
    // Drawer opened at 0; one 3000 cash sale → expected 3000.
    const closed = await closeSession({
      sessionId,
      closingCashMinor: 3000,
      closedByUserId: userId,
    });
    expect(closed.varianceMinor).toBe(0);
    const z = parseZ(closed.zReportJson);
    expect(z.cashSalesMinor).toBe(3000);
    expect(z.expectedCashMinor).toBe(3000);
    expect(z.orderCount).toBe(1);
  });

  test("z-report nets a cash refund against cash sales", async () => {
    const sessionId = await seedSession("P1");
    const variantId = await seedVariant({ priceMinor: 1000, stockQty: 100 });
    const order = await createPosOrder({
      posSessionId: sessionId,
      items: [{ variantId, qty: 3 }],
      payments: [{ amountMinor: 3000 }],
      createdByUserId: userId,
    });
    const itemId = (await listOrderItems(order.id))[0]!.id;
    await createReturn({
      originalOrderId: order.id,
      posSessionId: sessionId,
      items: [{ orderItemId: itemId, qty: 1 }],
      refundMethod: "cash",
      createdByUserId: userId,
    });
    // 3000 in, 1000 refunded out → 2000 net expected.
    const closed = await closeSession({
      sessionId,
      closingCashMinor: 2000,
      closedByUserId: userId,
    });
    expect(closed.varianceMinor).toBe(0);
    const z = parseZ(closed.zReportJson);
    expect(z.cashSalesMinor).toBe(2000);
    expect(z.returnCount).toBe(1);
  });

  test("an open console sale cannot be returned", async () => {
    const sessionId = await seedSession("P1");
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
    const itemId = (await listOrderItems(sale.id))[0]!.id;
    await expectError("ORDER_NOT_CLOSED", () =>
      createReturn({
        originalOrderId: sale.id,
        posSessionId: sessionId,
        items: [{ orderItemId: itemId, qty: 1 }],
        refundMethod: "cash",
        createdByUserId: userId,
      }),
    );
  });
});

describe("tracking attribution", () => {
  /** A tracking account; returns its id. */
  async function seedAccount(): Promise<string> {
    const a = await createTrackingAccount({
      name: "Abu Bakar",
      accountCategory: "liability.tracking.staff",
      counterCategory: "expense.commission",
      createdByUserId: userId,
    });
    return a.id;
  }

  test("a POS sale snapshots attribution on create but posts it at session close", async () => {
    const sessionId = await seedSession("P1");
    const accountId = await seedAccount();
    const variantId = await seedVariant({
      priceMinor: 1000,
      priceMode: "tax_exclusive",
      trackingAccountId: accountId,
      attributionMode: "full",
    });
    const order = await createPosOrder({
      posSessionId: sessionId,
      items: [{ variantId, qty: 3 }],
      payments: [{ amountMinor: 3000 }],
      createdByUserId: userId,
    });
    // Snapshot is on the line immediately; the ledger stays empty until close.
    const items = await listOrderItems(order.id);
    expect(items[0]!.attributionAccountId).toBe(accountId);
    expect(items[0]!.attributionAmountMinor).toBe(3000);
    expect((await getTrackingAccount(accountId)).balanceMinor).toBe(0);

    await closeSession({ sessionId, closingCashMinor: 3000, closedByUserId: userId });
    expect((await getTrackingAccount(accountId)).balanceMinor).toBe(3000);
  });

  test("percent mode attributes only the configured share", async () => {
    const sessionId = await seedSession("P1");
    const accountId = await seedAccount();
    const variantId = await seedVariant({
      priceMinor: 1000,
      priceMode: "tax_exclusive",
      trackingAccountId: accountId,
      attributionMode: "percent",
      attributionPctBps: 1000, // 10%
    });
    const order = await createPosOrder({
      posSessionId: sessionId,
      items: [{ variantId, qty: 5 }],
      payments: [{ amountMinor: 5000 }],
      createdByUserId: userId,
    });
    const items = await listOrderItems(order.id);
    expect(items[0]!.attributionAmountMinor).toBe(500);
  });

  test("tax-inclusive pricing attributes the pre-tax portion", async () => {
    const sessionId = await seedSession("P1");
    const accountId = await seedAccount();
    const variantId = await seedVariant({
      priceMinor: 1110,
      priceMode: "tax_inclusive",
      taxRateBps: 1100, // 11% — 1110 gross → 1000 pre-tax
      trackingAccountId: accountId,
      attributionMode: "full",
    });
    const order = await createPosOrder({
      posSessionId: sessionId,
      items: [{ variantId, qty: 1 }],
      payments: [{ amountMinor: 1110 }],
      createdByUserId: userId,
    });
    const items = await listOrderItems(order.id);
    expect(items[0]!.attributionAmountMinor).toBe(1000);
  });

  test("a cashier override replaces the computed attribution", async () => {
    const sessionId = await seedSession("P1");
    const accountId = await seedAccount();
    const variantId = await seedVariant({
      priceMinor: 1000,
      trackingAccountId: accountId,
      attributionMode: "full",
    });
    const order = await createPosOrder({
      posSessionId: sessionId,
      items: [{ variantId, qty: 3, attributionAmountOverrideMinor: 1200 }],
      payments: [{ amountMinor: 3000 }],
      createdByUserId: userId,
    });
    const items = await listOrderItems(order.id);
    expect(items[0]!.attributionAmountMinor).toBe(1200);

    await closeSession({ sessionId, closingCashMinor: 3000, closedByUserId: userId });
    expect((await getTrackingAccount(accountId)).balanceMinor).toBe(1200);
  });

  test("a sale and its return net at close — the return reverses proportionally", async () => {
    const sessionId = await seedSession("P1");
    const accountId = await seedAccount();
    const variantId = await seedVariant({
      priceMinor: 1000,
      trackingAccountId: accountId,
      attributionMode: "full",
      stockQty: 100,
    });
    const order = await createPosOrder({
      posSessionId: sessionId,
      items: [{ variantId, qty: 3 }],
      payments: [{ amountMinor: 3000 }],
      createdByUserId: userId,
    });
    const itemId = (await listOrderItems(order.id))[0]!.id;
    await createReturn({
      originalOrderId: order.id,
      posSessionId: sessionId,
      items: [{ orderItemId: itemId, qty: 1 }],
      refundMethod: "cash",
      createdByUserId: userId,
    });
    // Nothing posted while the session is open — sale and return both collect.
    expect((await getTrackingAccount(accountId)).balanceMinor).toBe(0);

    await closeSession({ sessionId, closingCashMinor: 2000, closedByUserId: userId });
    expect((await getTrackingAccount(accountId)).balanceMinor).toBe(2000);
  });

  test("reopening then reclosing a session does not double-post attribution", async () => {
    const sessionId = await seedSession("P1");
    const accountId = await seedAccount();
    const variantId = await seedVariant({
      priceMinor: 1000,
      priceMode: "tax_exclusive",
      trackingAccountId: accountId,
      attributionMode: "full",
    });
    await createPosOrder({
      posSessionId: sessionId,
      items: [{ variantId, qty: 3 }],
      payments: [{ amountMinor: 3000 }],
      createdByUserId: userId,
    });
    await closeSession({ sessionId, closingCashMinor: 3000, closedByUserId: userId });
    expect((await getTrackingAccount(accountId)).balanceMinor).toBe(3000);

    await reopenSession(sessionId);
    await closeSession({ sessionId, closingCashMinor: 3000, closedByUserId: userId });
    // Already-posted orders are skipped on the second close.
    expect((await getTrackingAccount(accountId)).balanceMinor).toBe(3000);
  });

  test("force-closing a session posts the collected attribution", async () => {
    const sessionId = await seedSession("P1");
    const accountId = await seedAccount();
    const variantId = await seedVariant({
      priceMinor: 1000,
      priceMode: "tax_exclusive",
      trackingAccountId: accountId,
      attributionMode: "full",
    });
    await createPosOrder({
      posSessionId: sessionId,
      items: [{ variantId, qty: 3 }],
      payments: [{ amountMinor: 3000 }],
      createdByUserId: userId,
    });
    expect((await getTrackingAccount(accountId)).balanceMinor).toBe(0);

    await forceCloseSession({ sessionId, closedByUserId: userId });
    expect((await getTrackingAccount(accountId)).balanceMinor).toBe(3000);
  });

  test("a console sale attributes on close only when fully paid", async () => {
    const accountId = await seedAccount();
    const customer = await createCustomer({ name: "Pak Budi", createdByUserId: userId });
    const variantId = await seedVariant({
      priceMinor: 1000,
      trackingAccountId: accountId,
      attributionMode: "full",
    });
    const sale = await createCustomerSale({
      customerId: customer.id,
      createdByUserId: userId,
    });
    await addCustomerSaleItem({
      orderId: sale.id,
      item: { variantId, qty: 2 },
      createdByUserId: userId,
    });
    // Attribution must not fire on item-add.
    expect((await getTrackingAccount(accountId)).balanceMinor).toBe(0);

    await addCustomerSalePayment({
      orderId: sale.id,
      amountMinor: 2000,
      createdByUserId: userId,
    });
    await closeCustomerSale({ orderId: sale.id, closedByUserId: userId });
    expect((await getTrackingAccount(accountId)).balanceMinor).toBe(2000);
  });

  test("a console sale closed on account does not attribute", async () => {
    const accountId = await seedAccount();
    const customer = await createCustomer({ name: "Pak Budi", createdByUserId: userId });
    const variantId = await seedVariant({
      priceMinor: 1000,
      trackingAccountId: accountId,
      attributionMode: "full",
    });
    const sale = await createCustomerSale({
      customerId: customer.id,
      createdByUserId: userId,
    });
    await addCustomerSaleItem({
      orderId: sale.id,
      item: { variantId, qty: 2 },
      createdByUserId: userId,
    });
    await closeCustomerSale({ orderId: sale.id, closedByUserId: userId });
    expect((await getTrackingAccount(accountId)).balanceMinor).toBe(0);
  });

  test("session close posts ONE bulked ledger row per account, not per line item", async () => {
    const sessionId = await seedSession("P1");
    const accountId = await seedAccount();
    const variantA = await seedVariant({
      priceMinor: 1000,
      priceMode: "tax_exclusive",
      trackingAccountId: accountId,
      attributionMode: "full",
    });
    const variantB = await seedVariant({
      priceMinor: 1000,
      priceMode: "tax_exclusive",
      trackingAccountId: accountId,
      attributionMode: "full",
    });
    // Two orders, three attributed lines total → 3000 + 2000 + 1000 = 6000.
    await createPosOrder({
      posSessionId: sessionId,
      items: [
        { variantId: variantA, qty: 3 },
        { variantId: variantB, qty: 2 },
      ],
      payments: [{ amountMinor: 5000 }],
      createdByUserId: userId,
    });
    await createPosOrder({
      posSessionId: sessionId,
      items: [{ variantId: variantA, qty: 1 }],
      payments: [{ amountMinor: 1000 }],
      createdByUserId: userId,
    });

    await closeSession({ sessionId, closingCashMinor: 6000, closedByUserId: userId });

    const ledger = await listTrackingAccountLedger(accountId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.type).toBe("attribution");
    expect(ledger[0]!.amountMinor).toBe(6000);
    expect(ledger[0]!.refType).toBe("pos_session");
    expect(ledger[0]!.refId).toBe(sessionId);
    expect(ledger[0]!.posSessionId).toBe(sessionId);
    expect((await getTrackingAccount(accountId)).balanceMinor).toBe(6000);
  });

  test("a console sale posts ONE bulked ledger row per account, refType order", async () => {
    const accountId = await seedAccount();
    const customer = await createCustomer({ name: "Pak Budi", createdByUserId: userId });
    const variantA = await seedVariant({
      priceMinor: 1000,
      priceMode: "tax_exclusive",
      trackingAccountId: accountId,
      attributionMode: "full",
    });
    const variantB = await seedVariant({
      priceMinor: 1000,
      priceMode: "tax_exclusive",
      trackingAccountId: accountId,
      attributionMode: "full",
    });
    const sale = await createCustomerSale({
      customerId: customer.id,
      createdByUserId: userId,
    });
    await addCustomerSaleItem({
      orderId: sale.id,
      item: { variantId: variantA, qty: 2 },
      createdByUserId: userId,
    });
    await addCustomerSaleItem({
      orderId: sale.id,
      item: { variantId: variantB, qty: 3 },
      createdByUserId: userId,
    });
    await addCustomerSalePayment({
      orderId: sale.id,
      amountMinor: 5000,
      createdByUserId: userId,
    });
    await closeCustomerSale({ orderId: sale.id, closedByUserId: userId });

    const ledger = await listTrackingAccountLedger(accountId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.amountMinor).toBe(5000);
    expect(ledger[0]!.refType).toBe("order");
    expect(ledger[0]!.refId).toBe(sale.id);
    expect((await getTrackingAccount(accountId)).balanceMinor).toBe(5000);
  });
});

describe("dual product naming", () => {
  test("an order line snapshots both the internal and public names", async () => {
    const sessionId = await seedSession("P1");
    const variantId = await seedVariant({
      priceMinor: 1000,
      publicName: "Premium Widget",
    });
    const order = await createPosOrder({
      posSessionId: sessionId,
      items: [{ variantId, qty: 1 }],
      payments: [{ amountMinor: 1000 }],
      createdByUserId: userId,
    });
    const item = (await listOrderItems(order.id))[0]!;
    expect(item.snapshotProductName).toBe("Widget");
    expect(item.snapshotPublicName).toBe("Premium Widget");
  });

  test("a product with no public name snapshots null", async () => {
    const sessionId = await seedSession("P1");
    const variantId = await seedVariant({ priceMinor: 1000 });
    const order = await createPosOrder({
      posSessionId: sessionId,
      items: [{ variantId, qty: 1 }],
      payments: [{ amountMinor: 1000 }],
      createdByUserId: userId,
    });
    const item = (await listOrderItems(order.id))[0]!;
    expect(item.snapshotPublicName).toBeNull();
  });

  test("a return order carries the public name snapshot forward", async () => {
    const sessionId = await seedSession("P1");
    const variantId = await seedVariant({
      priceMinor: 1000,
      stockQty: 100,
      publicName: "Premium Widget",
    });
    const order = await createPosOrder({
      posSessionId: sessionId,
      items: [{ variantId, qty: 2 }],
      payments: [{ amountMinor: 2000 }],
      createdByUserId: userId,
    });
    const itemId = (await listOrderItems(order.id))[0]!.id;
    const ret = await createReturn({
      originalOrderId: order.id,
      posSessionId: sessionId,
      items: [{ orderItemId: itemId, qty: 1 }],
      refundMethod: "cash",
      createdByUserId: userId,
    });
    const retItem = (await listOrderItems(ret.id))[0]!;
    expect(retItem.snapshotPublicName).toBe("Premium Widget");
  });
});

describe("product bundles", () => {
  /** Seed a bundle product priced at `priceMinor` with the given components. */
  async function seedBundle(
    priceMinor: number,
    components: { variantId: string; qty: number }[],
  ): Promise<string> {
    const bundleVariantId = await seedVariant({ kind: "bundle", priceMinor });
    await setBundleComponents(
      bundleVariantId,
      components.map((c) => ({ componentVariantId: c.variantId, qty: c.qty })),
    );
    return bundleVariantId;
  }

  test("selling a bundle explodes into one line per component", async () => {
    const sessionId = await seedSession("P1");
    const a = await seedVariant({ priceMinor: 1000, stockQty: 100 });
    const b = await seedVariant({ priceMinor: 1000, stockQty: 100 });
    // Bundle priced at 1500 — a 500 saving versus buying both separately.
    const bundle = await seedBundle(1500, [
      { variantId: a, qty: 1 },
      { variantId: b, qty: 1 },
    ]);

    const order = await createPosOrder({
      posSessionId: sessionId,
      items: [{ variantId: bundle, qty: 1 }],
      payments: [{ amountMinor: 1500 }],
      createdByUserId: userId,
    });
    expect(order.totalMinor).toBe(1500);

    const items = await listOrderItems(order.id);
    expect(items).toHaveLength(2);
    // No line references the bundle variant itself.
    expect(items.some((i) => i.variantId === bundle)).toBe(false);
    // Each component line is tagged with the bundle name.
    expect(items.every((i) => i.snapshotBundleName === "Widget")).toBe(true);
    // The split is proportional: 1500 over two equal-value components.
    const totals = items.map((i) => i.qty * i.snapshotPriceMinor - i.discountMinor);
    expect(totals.reduce((s, t) => s + t, 0)).toBe(1500);

    // Stock decremented per real component.
    expect(await stockOf(a)).toBe(99);
    expect(await stockOf(b)).toBe(99);
  });

  test("bundle qty and component qty both multiply the component line qty", async () => {
    const sessionId = await seedSession("P1");
    const a = await seedVariant({ priceMinor: 1000, stockQty: 100 });
    // The bundle contains 3 of component A.
    const bundle = await seedBundle(2000, [{ variantId: a, qty: 3 }]);

    // Buy 2 bundles → 2 × 3 = 6 units of A.
    const order = await createPosOrder({
      posSessionId: sessionId,
      items: [{ variantId: bundle, qty: 2 }],
      payments: [{ amountMinor: 4000 }],
      createdByUserId: userId,
    });
    const items = await listOrderItems(order.id);
    expect(items).toHaveLength(1);
    expect(items[0]!.qty).toBe(6);
    expect(order.totalMinor).toBe(4000);
    expect(await stockOf(a)).toBe(94);
  });

  test("a bundle with no components is rejected", async () => {
    const sessionId = await seedSession("P1");
    const bundle = await seedVariant({ kind: "bundle", priceMinor: 1000 });
    await expectError("INVALID_INPUT", () =>
      createPosOrder({
        posSessionId: sessionId,
        items: [{ variantId: bundle, qty: 1 }],
        payments: [{ amountMinor: 1000 }],
        createdByUserId: userId,
      }),
    );
  });

  test("setBundleComponents rejects nesting a bundle inside a bundle", async () => {
    const a = await seedVariant({ priceMinor: 1000 });
    const inner = await seedBundle(1500, [{ variantId: a, qty: 1 }]);
    const outer = await seedVariant({ kind: "bundle", priceMinor: 3000 });
    let code: string | undefined;
    try {
      await setBundleComponents(outer, [{ componentVariantId: inner, qty: 1 }]);
    } catch (e) {
      code = (e as ProductError).code;
    }
    expect(code).toBe("BUNDLE_NESTING");
  });
});

describe("listOrdersForReturn", () => {
  test("returns closed orders covering all requested variants; excludes partials", async () => {
    const sessionId = await seedSession("P1");
    const a = await seedVariant({ priceMinor: 1000, stockQty: 100 });
    const b = await seedVariant({ priceMinor: 1000, stockQty: 100 });

    const orderAB = await createPosOrder({
      posSessionId: sessionId,
      items: [{ variantId: a, qty: 2 }, { variantId: b, qty: 1 }],
      payments: [{ amountMinor: 3000 }],
      createdByUserId: userId,
    });
    const orderA = await createPosOrder({
      posSessionId: sessionId,
      items: [{ variantId: a, qty: 1 }],
      payments: [{ amountMinor: 1000 }],
      createdByUserId: userId,
    });

    const byA = (await listOrdersForReturn([a])).map((o) => o.id);
    expect(byA).toContain(orderAB.id);
    expect(byA).toContain(orderA.id);

    // Needs both variants — only the order that has both qualifies.
    const byAB = (await listOrdersForReturn([a, b])).map((o) => o.id);
    expect(byAB).toEqual([orderAB.id]);

    // No variants → nothing.
    expect(await listOrdersForReturn([])).toEqual([]);
  });

  test("excludes cancelled, open, and return orders", async () => {
    const sessionId = await seedSession("P1");
    const customer = await createCustomer({ name: "Pak Budi", createdByUserId: userId });
    const a = await seedVariant({ priceMinor: 1000, stockQty: 100 });

    // A normal closed sale — the one that should match.
    const closed = await createPosOrder({
      posSessionId: sessionId,
      items: [{ variantId: a, qty: 3 }],
      payments: [{ amountMinor: 3000 }],
      createdByUserId: userId,
    });

    // A return against it carries variant A but must not be offered for return.
    const itemId = (await listOrderItems(closed.id))[0]!.id;
    const ret = await createReturn({
      originalOrderId: closed.id,
      posSessionId: sessionId,
      items: [{ orderItemId: itemId, qty: 1 }],
      refundMethod: "cash",
      createdByUserId: userId,
    });

    // An open customer sale with variant A — not closed, so excluded.
    const open = await createCustomerSale({
      customerId: customer.id,
      createdByUserId: userId,
    });
    await addCustomerSaleItem({
      orderId: open.id,
      item: { variantId: a, qty: 1 },
      createdByUserId: userId,
    });

    // A cancelled customer sale with variant A — excluded.
    const cancelledSale = await createCustomerSale({
      customerId: customer.id,
      createdByUserId: userId,
    });
    await addCustomerSaleItem({
      orderId: cancelledSale.id,
      item: { variantId: a, qty: 1 },
      createdByUserId: userId,
    });
    await cancelCustomerSale({
      orderId: cancelledSale.id,
      reason: "test",
      cancelledByUserId: userId,
    });

    const ids = (await listOrdersForReturn([a])).map((o) => o.id);
    expect(ids).toEqual([closed.id]);
    expect(ids).not.toContain(ret.id);
    expect(ids).not.toContain(open.id);
    expect(ids).not.toContain(cancelledSale.id);
  });
});
