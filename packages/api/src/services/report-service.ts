// Report service: read-only aggregations over the existing ledgers, orders,
// and sessions — sales volume, cost/margin, AR/AP aging, cash-drawer variance.
// No schema of its own; nothing here writes. Retail data volumes are small,
// so each report loads the rows it needs and aggregates in JS.

import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { customerLedger, customers } from "../db/schema/customers.ts";
import { orderItems, orders } from "../db/schema/orders.ts";
import { pointsOfSale, posSessions } from "../db/schema/pos.ts";
import { vendorLedger, vendors } from "../db/schema/vendors.ts";
import { db } from "../lib/db.ts";

const MS_PER_DAY = 86_400_000;

/** A reporting period given as inclusive `YYYY-MM-DD` date strings. */
export interface DateRange {
  periodStart: string;
  periodEnd: string;
}

/** Resolve a date-string range to inclusive timestamp bounds. */
function rangeBounds(range: DateRange): { start: Date; end: Date } {
  return {
    start: new Date(`${range.periodStart}T00:00:00.000`),
    end: new Date(`${range.periodEnd}T23:59:59.999`),
  };
}

// --- Sales / cost / margin (one shared scan over the period) ---

interface PeriodAggregate {
  orderCount: number;
  itemsSoldQty: number;
  revenueMinor: number;
  cogsMinor: number;
  byDay: Map<string, { orderIds: Set<string>; revenueMinor: number }>;
}

/**
 * Scan non-voided line items of non-cancelled orders closed within the
 * period; the basis for the sales and profit reports.
 */
async function aggregatePeriod(range: DateRange): Promise<PeriodAggregate> {
  const { start, end } = rangeBounds(range);
  const rows = await db
    .select({
      orderId: orderItems.orderId,
      closedAt: orders.closedAt,
      priceMinor: orderItems.snapshotPriceMinor,
      costMinor: orderItems.snapshotCostMinor,
      qty: orderItems.qty,
      discountMinor: orderItems.discountMinor,
      attributionMinor: orderItems.attributionAmountMinor,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(
      and(
        isNull(orders.cancelledAt),
        isNull(orderItems.voidedAt),
        gte(orders.closedAt, start),
        lte(orders.closedAt, end),
      ),
    );

  const agg: PeriodAggregate = {
    orderCount: 0,
    itemsSoldQty: 0,
    revenueMinor: 0,
    cogsMinor: 0,
    byDay: new Map(),
  };
  const orderIds = new Set<string>();
  for (const r of rows) {
    // Net the tracking-account cut out of the shop's own revenue: a full-mode
    // attributed line nets to 0, a percent line keeps the shop's share. COGS is
    // untouched — the product cost the shop paid is real either way. Return
    // lines carry negative qty *and* attribution, so this reverses cleanly.
    const lineRevenue = r.priceMinor * r.qty - r.discountMinor - r.attributionMinor;
    const lineCogs = r.costMinor * r.qty;
    agg.revenueMinor += lineRevenue;
    agg.cogsMinor += lineCogs;
    agg.itemsSoldQty += r.qty;
    orderIds.add(r.orderId);

    const day = (r.closedAt ?? start).toISOString().slice(0, 10);
    const bucket = agg.byDay.get(day) ?? { orderIds: new Set(), revenueMinor: 0 };
    bucket.orderIds.add(r.orderId);
    bucket.revenueMinor += lineRevenue;
    agg.byDay.set(day, bucket);
  }
  agg.orderCount = orderIds.size;
  return agg;
}

export interface SalesReport {
  periodStart: string;
  periodEnd: string;
  orderCount: number;
  itemsSoldQty: number;
  revenueMinor: number;
  byDay: { date: string; orderCount: number; revenueMinor: number }[];
}

/** Sales volume: order count, units sold, revenue — total and by day. */
export async function salesReport(range: DateRange): Promise<SalesReport> {
  const agg = await aggregatePeriod(range);
  const byDay = [...agg.byDay.entries()]
    .map(([date, b]) => ({
      date,
      orderCount: b.orderIds.size,
      revenueMinor: b.revenueMinor,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    periodStart: range.periodStart,
    periodEnd: range.periodEnd,
    orderCount: agg.orderCount,
    itemsSoldQty: agg.itemsSoldQty,
    revenueMinor: agg.revenueMinor,
    byDay,
  };
}

export interface ProfitReport {
  periodStart: string;
  periodEnd: string;
  revenueMinor: number;
  cogsMinor: number;
  grossMarginMinor: number;
  /** Gross margin as basis points of revenue; 0 when revenue is 0. */
  marginBps: number;
}

/** Cost / margin: revenue vs COGS (snapshot WAC) and the resulting margin. */
export async function profitReport(range: DateRange): Promise<ProfitReport> {
  const agg = await aggregatePeriod(range);
  const grossMarginMinor = agg.revenueMinor - agg.cogsMinor;
  return {
    periodStart: range.periodStart,
    periodEnd: range.periodEnd,
    revenueMinor: agg.revenueMinor,
    cogsMinor: agg.cogsMinor,
    grossMarginMinor,
    marginBps:
      agg.revenueMinor === 0
        ? 0
        : Math.round((grossMarginMinor / agg.revenueMinor) * 10000),
  };
}

// --- AR / AP aging ---

export interface AgingRow {
  partyId: string;
  partyName: string;
  balanceMinor: number;
  bucket0_30: number;
  bucket31_60: number;
  bucket61_90: number;
  bucket90plus: number;
}

export interface AgingReport {
  asOf: string;
  rows: AgingRow[];
  totalBalanceMinor: number;
}

/**
 * One ledger row for aging: `createdAt` drives FIFO payment application (oldest
 * charge paid first); `ageAt` is the timestamp the charge is bucketed by — its
 * due date for AP, or simply `createdAt` where there are no terms.
 */
interface AgingEntry {
  amountMinor: number;
  createdAt: Date;
  ageAt: Date;
}

/**
 * Age the outstanding balance of one party's ledger. Credits (negative
 * amounts) consume the oldest charges first; each still-unpaid charge is
 * bucketed by how many days past its `ageAt` it is.
 */
function ageLedger(
  entries: AgingEntry[],
  now: number,
): Omit<AgingRow, "partyId" | "partyName"> | null {
  const charges = entries
    .filter((e) => e.amountMinor > 0)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((e) => ({ remaining: e.amountMinor, at: e.ageAt.getTime() }));
  let credit = entries
    .filter((e) => e.amountMinor < 0)
    .reduce((s, e) => s - e.amountMinor, 0);

  for (const charge of charges) {
    if (credit <= 0) break;
    const applied = Math.min(credit, charge.remaining);
    charge.remaining -= applied;
    credit -= applied;
  }

  const row = {
    balanceMinor: 0,
    bucket0_30: 0,
    bucket31_60: 0,
    bucket61_90: 0,
    bucket90plus: 0,
  };
  for (const charge of charges) {
    if (charge.remaining <= 0) continue;
    const ageDays = (now - charge.at) / MS_PER_DAY;
    row.balanceMinor += charge.remaining;
    if (ageDays <= 30) row.bucket0_30 += charge.remaining;
    else if (ageDays <= 60) row.bucket31_60 += charge.remaining;
    else if (ageDays <= 90) row.bucket61_90 += charge.remaining;
    else row.bucket90plus += charge.remaining;
  }
  // Credit left after settling every charge is an unapplied credit — the party
  // overpaid or holds store credit. Surface it as a negative current-bucket
  // balance so these accounts aren't silently dropped from the report.
  if (credit > 0) {
    row.balanceMinor -= credit;
    row.bucket0_30 -= credit;
  }
  return row.balanceMinor !== 0 ? row : null;
}

/** Build an aging report from a party-keyed set of ledger entries. */
function buildAging(
  parties: Map<string, { name: string; entries: AgingEntry[] }>,
): AgingReport {
  const now = Date.now();
  const rows: AgingRow[] = [];
  for (const [partyId, party] of parties) {
    const aged = ageLedger(party.entries, now);
    if (aged) rows.push({ partyId, partyName: party.name, ...aged });
  }
  rows.sort((a, b) => b.balanceMinor - a.balanceMinor);
  return {
    asOf: new Date(now).toISOString(),
    rows,
    totalBalanceMinor: rows.reduce((s, r) => s + r.balanceMinor, 0),
  };
}

/** Customer debt aging — who owes us, and how overdue. */
export async function arAgingReport(): Promise<AgingReport> {
  const rows = await db
    .select({
      customerId: customerLedger.customerId,
      name: customers.name,
      amountMinor: customerLedger.amountMinor,
      createdAt: customerLedger.createdAt,
    })
    .from(customerLedger)
    .innerJoin(customers, eq(customerLedger.customerId, customers.id));

  const parties = new Map<string, { name: string; entries: AgingEntry[] }>();
  for (const r of rows) {
    const p = parties.get(r.customerId) ?? { name: r.name, entries: [] };
    // Customers carry no terms — age from when the charge was incurred.
    p.entries.push({
      amountMinor: r.amountMinor,
      createdAt: r.createdAt,
      ageAt: r.createdAt,
    });
    parties.set(r.customerId, p);
  }
  return buildAging(parties);
}

/** Vendor debt aging — who we owe, and how overdue (by each charge's due date). */
export async function apAgingReport(): Promise<AgingReport> {
  const rows = await db
    .select({
      vendorId: vendorLedger.vendorId,
      name: vendors.name,
      amountMinor: vendorLedger.amountMinor,
      createdAt: vendorLedger.createdAt,
      dueDate: vendorLedger.dueDate,
    })
    .from(vendorLedger)
    .innerJoin(vendors, eq(vendorLedger.vendorId, vendors.id));

  const parties = new Map<string, { name: string; entries: AgingEntry[] }>();
  for (const r of rows) {
    const p = parties.get(r.vendorId) ?? { name: r.name, entries: [] };
    // Bucket by due date when the charge has terms; else by when incurred.
    p.entries.push({
      amountMinor: r.amountMinor,
      createdAt: r.createdAt,
      ageAt: r.dueDate ? new Date(`${r.dueDate}T00:00:00.000`) : r.createdAt,
    });
    parties.set(r.vendorId, p);
  }
  return buildAging(parties);
}

// --- Session variance ---

export interface SessionVarianceRow {
  sessionId: string;
  posCode: string;
  openedAt: string;
  closedAt: string | null;
  openingCashMinor: number;
  closingCashMinor: number | null;
  varianceMinor: number | null;
  forceClosed: boolean;
}

export interface SessionVarianceReport {
  periodStart: string;
  periodEnd: string;
  sessions: SessionVarianceRow[];
  /** Sum of variance over reconciled (non-force-closed) sessions. */
  totalVarianceMinor: number;
  /** Force-closed sessions have no variance figure. */
  unreconciledCount: number;
}

/** Cash-drawer variance for sessions closed within the period. */
export async function sessionVarianceReport(
  range: DateRange,
): Promise<SessionVarianceReport> {
  const { start, end } = rangeBounds(range);
  const rows = await db
    .select({
      sessionId: posSessions.id,
      posCode: pointsOfSale.code,
      openedAt: posSessions.openedAt,
      closedAt: posSessions.closedAt,
      openingCashMinor: posSessions.openingCashMinor,
      closingCashMinor: posSessions.closingCashMinor,
      varianceMinor: posSessions.varianceMinor,
      forceClosed: posSessions.forceClosed,
    })
    .from(posSessions)
    .innerJoin(pointsOfSale, eq(posSessions.posId, pointsOfSale.id))
    .where(and(gte(posSessions.closedAt, start), lte(posSessions.closedAt, end)));

  const sessions: SessionVarianceRow[] = rows.map((r) => ({
    sessionId: r.sessionId,
    posCode: r.posCode,
    openedAt: r.openedAt.toISOString(),
    closedAt: r.closedAt ? r.closedAt.toISOString() : null,
    openingCashMinor: r.openingCashMinor,
    closingCashMinor: r.closingCashMinor,
    varianceMinor: r.varianceMinor,
    forceClosed: r.forceClosed,
  }));

  return {
    periodStart: range.periodStart,
    periodEnd: range.periodEnd,
    sessions,
    totalVarianceMinor: sessions.reduce((s, r) => s + (r.varianceMinor ?? 0), 0),
    unreconciledCount: sessions.filter((r) => r.forceClosed).length,
  };
}
