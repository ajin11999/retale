// Integration tests for report-service — sales, cost/margin, AR/AP aging, and
// session variance. Runs against the local Docker MariaDB (DATABASE_URL) and
// WIPEs the order / ledger / session tables between tests.
//
//   bun test src/services/report-service.test.ts

import "../lib/load-env.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { users } from "../db/schema/auth.ts";
import { customerLedger, customers } from "../db/schema/customers.ts";
import { orderItems, orders } from "../db/schema/orders.ts";
import { pointsOfSale, posSessions } from "../db/schema/pos.ts";
import { locations } from "../db/schema/locations.ts";
import { vendorLedger, vendors } from "../db/schema/vendors.ts";
import { db } from "../lib/db.ts";
import {
  apAgingReport,
  arAgingReport,
  profitReport,
  salesReport,
  sessionVarianceReport,
  sessionVariantSales,
} from "./report-service.ts";

let userId: string;

async function wipe(): Promise<void> {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of [
    "order_payments",
    "order_items",
    "orders",
    "pos_sessions",
    "points_of_sale",
    "locations",
    "customer_ledger",
    "customers",
    "vendor_ledger",
    "vendors",
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
    name: "Report Test",
  });
});

afterAll(async () => {
  await wipe();
  await db.delete(users).where(eq(users.id, userId));
});

beforeEach(wipe);

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

/** Insert an order plus one line item. */
async function seedOrder(input: {
  closedAt: Date;
  cancelled?: boolean;
  qty: number;
  priceMinor: number;
  costMinor: number;
  discountMinor?: number;
  /** Tracking-account cut snapshotted on the line; netted out of revenue. */
  attributionMinor?: number;
}): Promise<void> {
  const orderId = ulid();
  await db.insert(orders).values({
    id: orderId,
    closedAt: input.closedAt,
    cancelledAt: input.cancelled ? input.closedAt : null,
    totalMinor: input.priceMinor * input.qty - (input.discountMinor ?? 0),
    createdByUserId: userId,
  });
  await db.insert(orderItems).values({
    id: ulid(),
    orderId,
    qty: input.qty,
    discountMinor: input.discountMinor ?? 0,
    snapshotProductName: "Widget",
    snapshotProductSku: `SKU-${ulid()}`,
    snapshotUnit: "piece",
    snapshotPriceMinor: input.priceMinor,
    snapshotCostMinor: input.costMinor,
    snapshotTaxRateBps: 0,
    snapshotPriceMode: "tax_exclusive",
    attributionAmountMinor: input.attributionMinor ?? 0,
  });
}

describe("salesReport / profitReport", () => {
  test("aggregates revenue, COGS and margin over the period", async () => {
    await seedOrder({ closedAt: new Date("2026-05-10T10:00:00"), qty: 2, priceMinor: 1000, costMinor: 600 });
    await seedOrder({ closedAt: new Date("2026-05-12T10:00:00"), qty: 1, priceMinor: 5000, costMinor: 3000 });
    // Cancelled order in range — excluded.
    await seedOrder({ closedAt: new Date("2026-05-11T10:00:00"), cancelled: true, qty: 9, priceMinor: 9000, costMinor: 1 });
    // Order outside the range — excluded.
    await seedOrder({ closedAt: new Date("2026-06-01T10:00:00"), qty: 1, priceMinor: 100, costMinor: 1 });

    const range = { periodStart: "2026-05-01", periodEnd: "2026-05-31" };
    const sales = await salesReport(range);
    expect(sales.orderCount).toBe(2);
    expect(sales.itemsSoldQty).toBe(3);
    expect(sales.revenueMinor).toBe(7000);
    expect(sales.byDay).toHaveLength(2);

    const profit = await profitReport(range);
    expect(profit.revenueMinor).toBe(7000);
    expect(profit.cogsMinor).toBe(4200);
    expect(profit.grossMarginMinor).toBe(2800);
    expect(profit.marginBps).toBe(4000); // 2800 / 7000
    // Daily revenue + COGS, sorted by date.
    expect(profit.byDay).toEqual([
      { date: "2026-05-10", revenueMinor: 2000, cogsMinor: 1200 },
      { date: "2026-05-12", revenueMinor: 5000, cogsMinor: 3000 },
    ]);
  });

  test("nets tracking-account attribution out of revenue (not COGS)", async () => {
    // Plain retail line — full revenue.
    await seedOrder({ closedAt: new Date("2026-05-10T10:00:00"), qty: 1, priceMinor: 10000, costMinor: 6000 });
    // full-mode service: the whole pre-tax line is the mechanic's — nets to 0.
    await seedOrder({ closedAt: new Date("2026-05-11T10:00:00"), qty: 1, priceMinor: 5000, costMinor: 0, attributionMinor: 5000 });
    // percent-mode line: 30% (1200 of 4000) goes to the mechanic; shop keeps 2800.
    await seedOrder({ closedAt: new Date("2026-05-12T10:00:00"), qty: 1, priceMinor: 4000, costMinor: 1000, attributionMinor: 1200 });

    const range = { periodStart: "2026-05-01", periodEnd: "2026-05-31" };
    const sales = await salesReport(range);
    // 10000 + (5000 − 5000) + (4000 − 1200) = 12800.
    expect(sales.revenueMinor).toBe(12800);
    // Units sold and order count ignore attribution.
    expect(sales.itemsSoldQty).toBe(3);
    expect(sales.orderCount).toBe(3);

    const profit = await profitReport(range);
    expect(profit.revenueMinor).toBe(12800);
    // COGS is untouched by attribution: 6000 + 0 + 1000.
    expect(profit.cogsMinor).toBe(7000);
    expect(profit.grossMarginMinor).toBe(5800);
  });
});

describe("arAgingReport", () => {
  test("FIFO-allocates payments and buckets the unpaid balance by age", async () => {
    const customerId = ulid();
    await db.insert(customers).values({ id: customerId, name: "Pak Budi" });
    await db.insert(customerLedger).values([
      { id: ulid(), customerId, type: "sale_on_account", amountMinor: 100000, createdAt: daysAgo(100) },
      { id: ulid(), customerId, type: "payment", amountMinor: -40000, createdAt: daysAgo(50) },
      { id: ulid(), customerId, type: "sale_on_account", amountMinor: 20000, createdAt: daysAgo(5) },
    ]);

    const report = await arAgingReport();
    expect(report.rows).toHaveLength(1);
    const row = report.rows[0]!;
    expect(row.partyName).toBe("Pak Budi");
    expect(row.balanceMinor).toBe(80000); // 100k - 40k payment + 20k
    expect(row.bucket90plus).toBe(60000); // oldest charge, 40k paid off
    expect(row.bucket0_30).toBe(20000);
    expect(report.totalBalanceMinor).toBe(80000);
  });

  test("omits a fully-settled customer", async () => {
    const customerId = ulid();
    await db.insert(customers).values({ id: customerId, name: "Settled" });
    await db.insert(customerLedger).values([
      { id: ulid(), customerId, type: "sale_on_account", amountMinor: 5000, createdAt: daysAgo(10) },
      { id: ulid(), customerId, type: "payment", amountMinor: -5000, createdAt: daysAgo(1) },
    ]);
    expect((await arAgingReport()).rows).toHaveLength(0);
  });

  test("surfaces an overpaid customer as a negative current-bucket balance", async () => {
    const customerId = ulid();
    await db.insert(customers).values({ id: customerId, name: "Overpaid" });
    await db.insert(customerLedger).values([
      { id: ulid(), customerId, type: "sale_on_account", amountMinor: 5000, createdAt: daysAgo(10) },
      { id: ulid(), customerId, type: "payment", amountMinor: -8000, createdAt: daysAgo(1) },
    ]);
    const report = await arAgingReport();
    expect(report.rows).toHaveLength(1);
    const row = report.rows[0]!;
    expect(row.balanceMinor).toBe(-3000); // 5k charge - 8k paid
    expect(row.bucket0_30).toBe(-3000);
    expect(row.bucket31_60).toBe(0);
    expect(report.totalBalanceMinor).toBe(-3000);
  });
});

describe("apAgingReport", () => {
  test("ages vendor debt the same way", async () => {
    const vendorId = ulid();
    await db.insert(vendors).values({ id: vendorId, name: "Acme" });
    await db.insert(vendorLedger).values([
      { id: ulid(), vendorId, type: "purchase_on_account", amountMinor: 30000, createdAt: daysAgo(45) },
    ]);
    const report = await apAgingReport();
    expect(report.rows[0]?.balanceMinor).toBe(30000);
    expect(report.rows[0]?.bucket31_60).toBe(30000);
  });

  test("buckets by due date, not when the charge was incurred", async () => {
    const vendorId = ulid();
    await db.insert(vendors).values({ id: vendorId, name: "Net-60 Vendor" });
    // Incurred 45 days ago, but with 60-day terms its due date is 15 days out —
    // still current, so it must land in the 0-30 bucket, not 31-60.
    const dueDate = new Date(Date.now() + 15 * 86_400_000).toISOString().slice(0, 10);
    await db.insert(vendorLedger).values([
      { id: ulid(), vendorId, type: "purchase_on_account", amountMinor: 30000, createdAt: daysAgo(45), dueDate },
    ]);
    const report = await apAgingReport();
    expect(report.rows[0]?.bucket0_30).toBe(30000);
    expect(report.rows[0]?.bucket31_60).toBe(0);
  });
});

describe("sessionVariantSales", () => {
  /** Create a location + POS + open session; returns the session id. */
  async function seedSession(code: string): Promise<string> {
    const locationId = ulid();
    await db.insert(locations).values({ id: locationId, name: "Store" });
    const posId = ulid();
    await db.insert(pointsOfSale).values({
      id: posId,
      locationId,
      code,
      name: "Register",
    });
    const sessionId = ulid();
    await db.insert(posSessions).values({
      id: sessionId,
      posId,
      openedByUserId: userId,
      openedAt: new Date(),
      openingCashMinor: 0,
    });
    return sessionId;
  }

  /** Insert one order in a session, with one line per item. */
  async function seedSessionOrder(input: {
    posSessionId: string;
    cancelled?: boolean;
    items: {
      sku: string;
      name?: string;
      variantLabel?: string | null;
      qty: number;
      priceMinor: number;
      costMinor: number;
      discountMinor?: number;
      attributionMinor?: number;
      voided?: boolean;
    }[];
  }): Promise<void> {
    const orderId = ulid();
    await db.insert(orders).values({
      id: orderId,
      posSessionId: input.posSessionId,
      closedAt: new Date(),
      cancelledAt: input.cancelled ? new Date() : null,
      totalMinor: 0,
      createdByUserId: userId,
    });
    await db.insert(orderItems).values(
      input.items.map((it) => ({
        id: ulid(),
        orderId,
        qty: it.qty,
        discountMinor: it.discountMinor ?? 0,
        snapshotProductName: it.name ?? "Widget",
        snapshotProductSku: it.sku,
        snapshotVariantLabel: it.variantLabel ?? null,
        snapshotUnit: "piece" as const,
        snapshotPriceMinor: it.priceMinor,
        snapshotCostMinor: it.costMinor,
        snapshotTaxRateBps: 0,
        snapshotPriceMode: "tax_exclusive" as const,
        attributionAmountMinor: it.attributionMinor ?? 0,
        voidedAt: it.voided ? new Date() : null,
      })),
    );
  }

  test("groups by variant, nets returns/attribution, scopes to the session", async () => {
    const sessionId = await seedSession("P1");
    const otherSession = await seedSession("P2");

    // Two sales touching A; the first also sells B with a mechanic's cut.
    await seedSessionOrder({
      posSessionId: sessionId,
      items: [
        { sku: "SKU-A", name: "Alpha", variantLabel: "Red", qty: 2, priceMinor: 1000, costMinor: 600 },
        { sku: "SKU-B", name: "Beta", qty: 1, priceMinor: 5000, costMinor: 3000, attributionMinor: 1200 },
      ],
    });
    await seedSessionOrder({
      posSessionId: sessionId,
      items: [{ sku: "SKU-A", name: "Alpha", variantLabel: "Red", qty: 3, priceMinor: 1000, costMinor: 600 }],
    });
    // A return of one A in the same session — negative qty/revenue/cost.
    await seedSessionOrder({
      posSessionId: sessionId,
      items: [{ sku: "SKU-A", name: "Alpha", variantLabel: "Red", qty: -1, priceMinor: 1000, costMinor: 600 }],
    });
    // Voided line — excluded.
    await seedSessionOrder({
      posSessionId: sessionId,
      items: [{ sku: "SKU-A", qty: 9, priceMinor: 1000, costMinor: 600, voided: true }],
    });
    // Cancelled order — excluded.
    await seedSessionOrder({
      posSessionId: sessionId,
      cancelled: true,
      items: [{ sku: "SKU-A", qty: 7, priceMinor: 1000, costMinor: 600 }],
    });
    // Another session — excluded.
    await seedSessionOrder({
      posSessionId: otherSession,
      items: [{ sku: "SKU-A", qty: 5, priceMinor: 1000, costMinor: 600 }],
    });

    const rows = await sessionVariantSales(sessionId);
    expect(rows).toHaveLength(2);

    // Sorted by revenue desc: A = 2000 + 3000 − 1000 = 4000; B = 5000 − 1200 = 3800.
    const [a, b] = rows;
    expect(a!.sku).toBe("SKU-A");
    expect(a!.productName).toBe("Alpha");
    expect(a!.variantLabel).toBe("Red");
    expect(a!.qtySold).toBe(4); // 2 + 3 − 1
    expect(a!.revenueMinor).toBe(4000);
    expect(a!.costMinor).toBe(2400); // 600 × 4

    expect(b!.sku).toBe("SKU-B");
    expect(b!.qtySold).toBe(1);
    expect(b!.revenueMinor).toBe(3800); // attribution netted out
    expect(b!.costMinor).toBe(3000);
  });
});

describe("sessionVarianceReport", () => {
  test("lists sessions closed in the period and totals the variance", async () => {
    const locationId = ulid();
    await db.insert(locations).values({ id: locationId, name: "Store" });
    const posId = ulid();
    await db.insert(pointsOfSale).values({
      id: posId,
      locationId,
      code: "P1",
      name: "Register 1",
    });
    await db.insert(posSessions).values([
      {
        id: ulid(),
        posId,
        openedByUserId: userId,
        openedAt: new Date("2026-05-10T08:00:00"),
        openingCashMinor: 100000,
        closedByUserId: userId,
        closedAt: new Date("2026-05-10T17:00:00"),
        closingCashMinor: 100500,
        varianceMinor: 500,
      },
      {
        id: ulid(),
        posId,
        openedByUserId: userId,
        openedAt: new Date("2026-05-11T08:00:00"),
        openingCashMinor: 100000,
        closedAt: new Date("2026-05-11T17:00:00"),
        forceClosed: true,
      },
    ]);

    const report = await sessionVarianceReport({
      periodStart: "2026-05-01",
      periodEnd: "2026-05-31",
    });
    expect(report.sessions).toHaveLength(2);
    expect(report.totalVarianceMinor).toBe(500);
    expect(report.unreconciledCount).toBe(1);
  });
});
