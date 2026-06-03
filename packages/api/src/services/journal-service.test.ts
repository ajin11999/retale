// Integration tests for journal-service — the double-entry export. Runs
// against the local Docker MariaDB (DATABASE_URL) and WIPEs the order /
// ledger / movement / purchase tables between tests. A product, variant and
// location are seeded once (stock_movements needs a real variant FK).
//
//   bun test src/services/journal-service.test.ts

import "../lib/load-env.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { users } from "../db/schema/auth.ts";
import { customerLedger, customers } from "../db/schema/customers.ts";
import {
  purchaseDeliveries,
  purchaseDeliveryItems,
} from "../db/schema/deliveries.ts";
import { locations } from "../db/schema/locations.ts";
import { orderItems, orderPayments, orders } from "../db/schema/orders.ts";
import { products, productVariants } from "../db/schema/products.ts";
import { purchaseItems, purchases } from "../db/schema/purchases.ts";
import { stockMovements } from "../db/schema/stock.ts";
import {
  trackingAccountLedger,
  trackingAccounts,
} from "../db/schema/tracking.ts";
import { vendorLedger, vendors } from "../db/schema/vendors.ts";
import { db } from "../lib/db.ts";
import {
  type JournalExport,
  journalExport,
  toJournalCsv,
  toSummaryCsv,
} from "./journal-service.ts";

const RANGE = { periodStart: "2026-05-01", periodEnd: "2026-05-31" };
const inMay = (day: number, hour = 10) =>
  new Date(`2026-05-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00`);

let userId: string;
let productId: string;
let variantId: string;
let locationId: string;

async function wipe(): Promise<void> {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of [
    "order_payments",
    "order_items",
    "orders",
    "stock_movements",
    "customer_ledger",
    "customers",
    "vendor_ledger",
    "vendors",
    "tracking_account_ledger",
    "tracking_accounts",
    "purchase_delivery_items",
    "purchase_deliveries",
    "purchase_items",
    "purchases",
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
    name: "Journal Test",
  });
  locationId = ulid();
  await db.insert(locations).values({ id: locationId, name: "Store" });
  productId = ulid();
  await db.insert(products).values({
    id: productId,
    name: "Widget",
    priceMode: "tax_exclusive",
  });
  variantId = ulid();
  await db.insert(productVariants).values({
    id: variantId,
    productId,
    sku: `SKU-${variantId}`,
    priceMinor: 1000,
  });
});

afterAll(async () => {
  await wipe();
  await db.delete(productVariants).where(eq(productVariants.id, variantId));
  await db.delete(products).where(eq(products.id, productId));
  await db.delete(locations).where(eq(locations.id, locationId));
  await db.delete(users).where(eq(users.id, userId));
});

beforeEach(wipe);

/** Insert an order with one line item and optional cash payment. */
async function seedOrder(input: {
  closedAt: Date;
  qty: number;
  priceMinor: number;
  costMinor?: number;
  discountMinor?: number;
  taxRateBps?: number;
  priceMode?: "tax_inclusive" | "tax_exclusive";
  cashPaidMinor?: number;
  customerId?: string;
  customerName?: string;
  returnOf?: string;
  voided?: boolean;
}): Promise<string> {
  const orderId = ulid();
  await db.insert(orders).values({
    id: orderId,
    displayNumber: `O-${orderId.slice(-6)}`,
    closedAt: input.closedAt,
    customerId: input.customerId ?? null,
    snapshotCustomerName: input.customerName ?? null,
    returnOfOrderId: input.returnOf ?? null,
    createdByUserId: userId,
  });
  await db.insert(orderItems).values({
    id: ulid(),
    orderId,
    qty: input.qty,
    discountMinor: input.discountMinor ?? 0,
    voidedAt: input.voided ? input.closedAt : null,
    snapshotProductName: "Widget",
    snapshotProductSku: `SKU-${ulid()}`,
    snapshotUnit: "piece",
    snapshotPriceMinor: input.priceMinor,
    snapshotCostMinor: input.costMinor ?? 0,
    snapshotTaxRateBps: input.taxRateBps ?? 0,
    snapshotPriceMode: input.priceMode ?? "tax_exclusive",
  });
  if (input.cashPaidMinor !== undefined) {
    await db.insert(orderPayments).values({
      id: ulid(),
      orderId,
      method: "cash",
      amountMinor: input.cashPaidMinor,
    });
  }
  return orderId;
}

/** Assert every entry in the export is internally balanced. */
function expectAllBalanced(data: JournalExport): void {
  for (const entry of data.entries) {
    const debit = entry.lines.reduce((s, l) => s + l.debitMinor, 0);
    const credit = entry.lines.reduce((s, l) => s + l.creditMinor, 0);
    expect(debit).toBe(credit);
  }
  expect(data.warnings.filter((w) => w.kind === "unbalanced_entry")).toEqual([]);
}

describe("sales & returns", () => {
  test("a cash sale debits cash and credits revenue", async () => {
    const orderId = await seedOrder({
      closedAt: inMay(10),
      qty: 2,
      priceMinor: 1000,
      cashPaidMinor: 2000,
    });
    const data = await journalExport(RANGE);
    expectAllBalanced(data);

    const sale = data.entries.find(
      (e) => e.refId === orderId && e.description.startsWith("Sale"),
    );
    expect(sale).toBeDefined();
    const lines = Object.fromEntries(
      sale!.lines.map((l) => [l.accountCategory, l]),
    );
    expect(lines["asset.cash"]?.debitMinor).toBe(2000);
    expect(lines["revenue.sales"]?.creditMinor).toBe(2000);
  });

  test("an unpaid sale to a customer lands in receivable", async () => {
    const customerId = ulid();
    await db.insert(customers).values({ id: customerId, name: "Pak Budi" });
    const orderId = await seedOrder({
      closedAt: inMay(11),
      qty: 1,
      priceMinor: 5000,
      customerId,
      customerName: "Pak Budi",
    });
    const data = await journalExport(RANGE);
    expectAllBalanced(data);

    const sale = data.entries.find((e) => e.refId === orderId)!;
    expect(sale.partyType).toBe("customer");
    const lines = Object.fromEntries(
      sale.lines.map((l) => [l.accountCategory, l]),
    );
    expect(lines["asset.receivable"]?.debitMinor).toBe(5000);
    expect(lines["revenue.sales"]?.creditMinor).toBe(5000);
  });

  test("a tax-inclusive sale splits out output tax", async () => {
    const orderId = await seedOrder({
      closedAt: inMay(12),
      qty: 1,
      priceMinor: 11100,
      taxRateBps: 1100,
      priceMode: "tax_inclusive",
      cashPaidMinor: 11100,
    });
    const data = await journalExport(RANGE);
    expectAllBalanced(data);

    const lines = Object.fromEntries(
      data.entries
        .find((e) => e.refId === orderId)!
        .lines.map((l) => [l.accountCategory, l]),
    );
    // 11100 inclusive of 11% → tax = round(11100 * 1100 / 11100) = 1100.
    expect(lines["liability.tax.output"]?.creditMinor).toBe(1100);
    expect(lines["revenue.sales"]?.creditMinor).toBe(10000);
    expect(lines["asset.cash"]?.debitMinor).toBe(11100);
  });

  test("a discount posts as contra-revenue", async () => {
    const orderId = await seedOrder({
      closedAt: inMay(13),
      qty: 1,
      priceMinor: 1000,
      discountMinor: 200,
      cashPaidMinor: 800,
    });
    const data = await journalExport(RANGE);
    expectAllBalanced(data);

    const lines = Object.fromEntries(
      data.entries
        .find((e) => e.refId === orderId)!
        .lines.map((l) => [l.accountCategory, l]),
    );
    expect(lines["revenue.sales"]?.creditMinor).toBe(1000);
    expect(lines["revenue.sales.discount"]?.debitMinor).toBe(200);
    expect(lines["asset.cash"]?.debitMinor).toBe(800);
  });

  test("a return order reverses the sale, and voided items are excluded", async () => {
    const original = await seedOrder({
      closedAt: inMay(5),
      qty: 1,
      priceMinor: 3000,
      cashPaidMinor: 3000,
    });
    const returnId = await seedOrder({
      closedAt: inMay(14),
      qty: -1,
      priceMinor: 3000,
      cashPaidMinor: -3000,
      returnOf: original,
    });
    // A fully-voided order contributes nothing.
    await seedOrder({
      closedAt: inMay(15),
      qty: 4,
      priceMinor: 9999,
      cashPaidMinor: 39996,
      voided: true,
    });

    const data = await journalExport(RANGE);
    expectAllBalanced(data);

    const ret = data.entries.find(
      (e) => e.refId === returnId && e.description.startsWith("Return"),
    )!;
    const lines = Object.fromEntries(
      ret.lines.map((l) => [l.accountCategory, l]),
    );
    // Cash refunded out, revenue reversed.
    expect(lines["asset.cash"]?.creditMinor).toBe(3000);
    expect(lines["revenue.sales"]?.debitMinor).toBe(3000);
    // The voided order produced no entry.
    expect(data.entries.some((e) => e.description.includes("9999"))).toBe(false);
  });
});

describe("COGS, receiving & inventory loss", () => {
  test("sale movements aggregate into a COGS entry", async () => {
    const orderId = await seedOrder({
      closedAt: inMay(10),
      qty: 2,
      priceMinor: 1000,
      cashPaidMinor: 2000,
    });
    await db.insert(stockMovements).values({
      id: ulid(),
      variantId,
      type: "sale",
      qtyDelta: -2,
      unitCost: 600,
      refType: "order",
      refId: orderId,
      createdAt: inMay(10),
    });
    const data = await journalExport(RANGE);
    expectAllBalanced(data);

    const cogs = data.entries.find((e) => e.description.startsWith("COGS"))!;
    const lines = Object.fromEntries(
      cogs.lines.map((l) => [l.accountCategory, l]),
    );
    expect(lines["cogs.product"]?.debitMinor).toBe(1200);
    expect(lines["asset.inventory"]?.creditMinor).toBe(1200);
  });

  test("a purchase_receive movement debits inventory and credits payable", async () => {
    await db.insert(stockMovements).values({
      id: ulid(),
      variantId,
      type: "purchase_receive",
      qtyDelta: 10,
      unitCost: 500,
      refType: "purchase",
      refId: ulid(),
      createdAt: inMay(8),
    });
    const data = await journalExport(RANGE);
    expectAllBalanced(data);

    const receive = data.entries.find(
      (e) => e.refType === "purchase_delivery",
    )!;
    const lines = Object.fromEntries(
      receive.lines.map((l) => [l.accountCategory, l]),
    );
    expect(lines["asset.inventory"]?.debitMinor).toBe(5000);
    expect(lines["liability.payable"]?.creditMinor).toBe(5000);
  });

  test("receiving sources AP from the ledger, splitting supplier and courier", async () => {
    // A committed delivery: stock landed at 6000 (5000 goods + 1000 freight),
    // with the goods owed to the supplier and the freight to a courier.
    const supplierId = ulid();
    const courierId = ulid();
    await db.insert(vendors).values([
      { id: supplierId, name: "Acme Supply", kind: "supplier" },
      { id: courierId, name: "JNE", kind: "expedition" },
    ]);
    const purchaseId = ulid();
    await db.insert(purchases).values({
      id: purchaseId,
      vendorId: supplierId,
      snapshotVendorName: "Acme Supply",
      date: "2026-05-08",
    });
    const deliveryId = ulid();
    await db.insert(purchaseDeliveries).values({
      id: deliveryId,
      date: "2026-05-08",
      targetLocationId: locationId,
      purchaseId,
      status: "delivered",
      deliveredAt: inMay(8),
    });
    await db.insert(stockMovements).values({
      id: ulid(),
      variantId,
      type: "purchase_receive",
      qtyDelta: 10,
      unitCost: 600, // landed unit cost → 6000 capitalized
      refType: "purchase",
      refId: deliveryId,
      createdAt: inMay(8),
    });
    await db.insert(vendorLedger).values([
      { id: ulid(), vendorId: supplierId, type: "purchase_on_account", amountMinor: 5000, refType: "purchase_delivery", refId: deliveryId, createdAt: inMay(8) },
      { id: ulid(), vendorId: courierId, type: "purchase_on_account", amountMinor: 1000, refType: "purchase_delivery", refId: deliveryId, createdAt: inMay(8) },
    ]);

    const data = await journalExport(RANGE);
    expectAllBalanced(data);

    const receive = data.entries.find((e) => e.refId === deliveryId)!;
    const lines = Object.fromEntries(receive.lines.map((l) => [l.accountCategory, l]));
    expect(lines["asset.inventory"]?.debitMinor).toBe(6000);
    expect(lines["liability.payable"]?.creditMinor).toBe(6000); // 5000 + 1000
    // The two sides agree exactly — no residual plug, no residual warnings.
    expect(
      data.warnings.some(
        (w) =>
          w.refId === deliveryId &&
          (w.kind === "receiving_residual" || w.kind === "untagged_expense"),
      ),
    ).toBe(false);
  });

  test("a stock adjustment is reported as an untagged warning", async () => {
    await db.insert(stockMovements).values({
      id: ulid(),
      variantId,
      type: "adjustment_out",
      qtyDelta: -3,
      unitCost: 400,
      refType: "adjustment",
      refId: ulid(),
      createdAt: inMay(9),
    });
    const data = await journalExport(RANGE);
    expect(data.warnings.some((w) => w.kind === "untagged_adjustment")).toBe(true);
  });
});

describe("ledger settlements", () => {
  test("a customer payment moves cash against receivable", async () => {
    const customerId = ulid();
    await db.insert(customers).values({ id: customerId, name: "Pak Budi" });
    await db.insert(customerLedger).values({
      id: ulid(),
      customerId,
      type: "payment",
      amountMinor: -3000,
      createdAt: inMay(20),
    });
    const data = await journalExport(RANGE);
    expectAllBalanced(data);

    const pay = data.entries.find((e) => e.refType === "customer_payment")!;
    const lines = Object.fromEntries(
      pay.lines.map((l) => [l.accountCategory, l]),
    );
    expect(lines["asset.cash"]?.debitMinor).toBe(3000);
    expect(lines["asset.receivable"]?.creditMinor).toBe(3000);
  });

  test("a vendor payment moves payable against cash", async () => {
    const vendorId = ulid();
    await db.insert(vendors).values({ id: vendorId, name: "Acme" });
    await db.insert(vendorLedger).values({
      id: ulid(),
      vendorId,
      type: "payment",
      amountMinor: -4000,
      createdAt: inMay(21),
    });
    const data = await journalExport(RANGE);
    expectAllBalanced(data);

    const pay = data.entries.find((e) => e.refType === "vendor_payment")!;
    const lines = Object.fromEntries(
      pay.lines.map((l) => [l.accountCategory, l]),
    );
    expect(lines["liability.payable"]?.debitMinor).toBe(4000);
    expect(lines["asset.cash"]?.creditMinor).toBe(4000);
  });

  test("a customer adjustment is reported as an untagged warning", async () => {
    const customerId = ulid();
    await db.insert(customers).values({ id: customerId, name: "Pak Budi" });
    await db.insert(customerLedger).values({
      id: ulid(),
      customerId,
      type: "adjustment",
      amountMinor: -1500,
      note: "write-off",
      createdAt: inMay(22),
    });
    const data = await journalExport(RANGE);
    expect(
      data.warnings.some(
        (w) => w.kind === "untagged_adjustment" && w.refType === "customer_ledger",
      ),
    ).toBe(true);
  });
});

describe("tracking-account ledger", () => {
  test("attribution debits the counter and credits the account category", async () => {
    const accountId = ulid();
    await db.insert(trackingAccounts).values({
      id: accountId,
      name: "Mechanic Joko",
      accountCategory: "liability.tracking.staff",
      counterCategory: "expense.commission",
    });
    await db.insert(trackingAccountLedger).values([
      {
        id: ulid(),
        trackingAccountId: accountId,
        type: "attribution",
        amountMinor: 1500,
        createdAt: inMay(18),
      },
      {
        id: ulid(),
        trackingAccountId: accountId,
        type: "payout",
        amountMinor: -1000,
        createdAt: inMay(25),
      },
    ]);
    const data = await journalExport(RANGE);
    expectAllBalanced(data);

    const attribution = data.entries.find(
      (e) => e.refType === "tracking_attribution",
    )!;
    const aLines = Object.fromEntries(
      attribution.lines.map((l) => [l.accountCategory, l]),
    );
    expect(aLines["expense.commission"]?.debitMinor).toBe(1500);
    expect(aLines["liability.tracking.staff"]?.creditMinor).toBe(1500);

    const payout = data.entries.find((e) => e.refType === "tracking_payout")!;
    const pLines = Object.fromEntries(
      payout.lines.map((l) => [l.accountCategory, l]),
    );
    expect(pLines["liability.tracking.staff"]?.debitMinor).toBe(1000);
    expect(pLines["asset.cash"]?.creditMinor).toBe(1000);
  });

  test("a category outside the catalog raises a warning", async () => {
    const accountId = ulid();
    await db.insert(trackingAccounts).values({
      id: accountId,
      name: "Odd account",
      accountCategory: "liability.tracking.staff",
      counterCategory: "expense.not_a_real_category",
    });
    await db.insert(trackingAccountLedger).values({
      id: ulid(),
      trackingAccountId: accountId,
      type: "attribution",
      amountMinor: 500,
      createdAt: inMay(19),
    });
    const data = await journalExport(RANGE);
    expect(
      data.warnings.some((w) => w.kind === "unknown_account_category"),
    ).toBe(true);
  });
});

describe("non-stock purchase lines", () => {
  test("a delivered non-stock line is reported as an untagged warning", async () => {
    const purchaseId = ulid();
    await db.insert(purchases).values({
      id: purchaseId,
      snapshotVendorName: "Acme",
      date: "2026-05-01",
    });
    const itemId = ulid();
    await db.insert(purchaseItems).values({
      id: itemId,
      purchaseId,
      variantId: null,
      description: "Shop rags",
      qtyOrdered: 5,
      unitCostMinor: 200,
    });
    const deliveryId = ulid();
    await db.insert(purchaseDeliveries).values({
      id: deliveryId,
      date: "2026-05-16",
      targetLocationId: locationId,
      purchaseId,
      status: "delivered",
      deliveredAt: inMay(16),
    });
    await db.insert(purchaseDeliveryItems).values({
      id: ulid(),
      deliveryId,
      purchaseItemId: itemId,
      description: "Shop rags",
      qty: 5,
      costMinor: 1000,
    });
    const data = await journalExport(RANGE);
    expect(
      data.warnings.some((w) => w.kind === "untagged_nonstock_purchase"),
    ).toBe(true);
  });
});

describe("summary & CSV", () => {
  test("the monthly summary aggregates by account and the CSV mirrors it", async () => {
    await seedOrder({
      closedAt: inMay(10),
      qty: 1,
      priceMinor: 1000,
      cashPaidMinor: 1000,
    });
    await seedOrder({
      closedAt: inMay(20),
      qty: 1,
      priceMinor: 4000,
      cashPaidMinor: 4000,
    });
    const data = await journalExport(RANGE);

    const cash = data.summary.find(
      (r) => r.month === "2026-05" && r.accountCategory === "asset.cash",
    )!;
    expect(cash.debitTotalMinor).toBe(5000);

    const journalCsv = toJournalCsv(data, "minor");
    expect(journalCsv.split("\r\n")[0]).toBe(
      "date,ref,description,party,account,debit,credit",
    );
    expect(journalCsv).toContain("revenue.sales");

    const summaryCsv = toSummaryCsv(data, "major");
    expect(summaryCsv.split("\r\n")[0]).toBe(
      "month,account,debit_total,credit_total",
    );
    // major formatting: 5000 minor → "50.00".
    expect(summaryCsv).toContain("asset.cash,50.00");
  });
});
