// Journal export service: derives a balanced, period-bounded double-entry
// journal from the existing subsidiary ledgers — orders, stock_movements,
// customer/vendor ledgers, tracking ledger — for import into external
// accounting software (GnuCash). Retale keeps no internal GL; see
// docs/design-decisions.md → "Accounting & exports".
//
// ~90% of events auto-classify from their source-row shape. Events that need
// an explicit `account_category` tag (manual adjustments, non-stock purchase
// lines) are not yet tagged in the schema — those surface in `warnings[]`
// instead of as journal lines. Nothing here writes; retail data volumes are
// small, so each scan loads its rows and aggregates in JS.

import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { customerLedger, customers } from "../db/schema/customers.ts";
import { purchaseDeliveries, purchaseDeliveryItems } from "../db/schema/deliveries.ts";
import { orderItems, orderPayments, orders } from "../db/schema/orders.ts";
import { purchaseItems, purchases } from "../db/schema/purchases.ts";
import { stockMovements } from "../db/schema/stock.ts";
import { trackingAccountLedger, trackingAccounts } from "../db/schema/tracking.ts";
import { vendorLedger, vendors } from "../db/schema/vendors.ts";
import { isKnownAccountCategory } from "../lib/account-categories.ts";
import { db } from "../lib/db.ts";
import { roundMoney } from "../lib/money.ts";

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

/** One side of a journal entry — exactly one of debit/credit is nonzero. */
export interface JournalLine {
  accountCategory: string;
  debitMinor: number;
  creditMinor: number;
}

/** A balanced journal entry: `SUM(debitMinor) === SUM(creditMinor)`. */
export interface JournalEntry {
  /** ISO timestamp of the underlying event. */
  date: string;
  refType: string;
  refId: string;
  description: string;
  partyType: "customer" | "vendor" | null;
  partyId: string | null;
  /** Snapshot name, not a live join — survives a hard-deleted party. */
  partyName: string | null;
  lines: JournalLine[];
}

/** Monthly debit/credit totals for one account category. */
export interface JournalSummaryRow {
  /** `YYYY-MM`. */
  month: string;
  accountCategory: string;
  debitTotalMinor: number;
  creditTotalMinor: number;
}

/** A non-fatal issue: an untagged event, an imbalance, an unknown category. */
export interface JournalWarning {
  kind: string;
  refType?: string;
  refId?: string;
  message: string;
}

export interface JournalExport {
  periodStart: string;
  periodEnd: string;
  entries: JournalEntry[];
  summary: JournalSummaryRow[];
  warnings: JournalWarning[];
}

// --- Entry assembly ---

/** A signed posting: positive lands on the debit side, negative on credit. */
interface Posting {
  category: string;
  amountMinor: number;
}

/** Net postings by category, then split each net into a debit/credit line. */
function postingsToLines(postings: Posting[]): JournalLine[] {
  const net = new Map<string, number>();
  for (const p of postings) {
    net.set(p.category, (net.get(p.category) ?? 0) + p.amountMinor);
  }
  const lines: JournalLine[] = [];
  for (const [accountCategory, n] of net) {
    if (n === 0) continue;
    lines.push(
      n > 0
        ? { accountCategory, debitMinor: n, creditMinor: 0 }
        : { accountCategory, debitMinor: 0, creditMinor: -n },
    );
  }
  return lines;
}

/**
 * Build an entry from signed postings and append it. Postings net to zero by
 * construction; the balance check is defensive — a nonzero residual means a
 * classifier bug, and is surfaced as a warning rather than silently shipped.
 * Entries that reduce to no lines (a fully-voided order) are dropped.
 */
function emitEntry(
  entries: JournalEntry[],
  warnings: JournalWarning[],
  head: Omit<JournalEntry, "lines">,
  postings: Posting[],
): void {
  const lines = postingsToLines(postings);
  if (lines.length === 0) return;
  const debit = lines.reduce((s, l) => s + l.debitMinor, 0);
  const credit = lines.reduce((s, l) => s + l.creditMinor, 0);
  if (debit !== credit) {
    warnings.push({
      kind: "unbalanced_entry",
      refType: head.refType,
      refId: head.refId,
      message: `entry debits (${debit}) do not equal credits (${credit})`,
    });
  }
  entries.push({ ...head, lines });
}

/**
 * Split a tax-bearing line total into its tax and net-revenue portions.
 * `tax_inclusive` carves the tax out of the amount; `tax_exclusive` adds it
 * on top — see docs/design-decisions.md → "Accounting & exports" → "Tax".
 */
function splitTax(
  netChargedMinor: number,
  rateBps: number,
  mode: "tax_inclusive" | "tax_exclusive",
): { taxMinor: number; netRevenueMinor: number } {
  if (rateBps === 0) return { taxMinor: 0, netRevenueMinor: netChargedMinor };
  if (mode === "tax_inclusive") {
    const taxMinor = roundMoney((netChargedMinor * rateBps) / (10000 + rateBps));
    return { taxMinor, netRevenueMinor: netChargedMinor - taxMinor };
  }
  const taxMinor = roundMoney((netChargedMinor * rateBps) / 10000);
  return { taxMinor, netRevenueMinor: netChargedMinor };
}

// --- The export ---

interface OrderRow {
  id: string;
  displayNumber: string | null;
  closedAt: Date | null;
  customerId: string | null;
  snapshotCustomerName: string | null;
  returnOfOrderId: string | null;
}

/** Per-order revenue accumulators, summed over its live line items. */
interface OrderAccumulator {
  /** Net-of-tax revenue, gross of discount — the `revenue.sales` credit. */
  revenueCredit: number;
  /** Discount total — the `revenue.sales.discount` contra-revenue debit. */
  discountDebit: number;
  /** Output tax total — the `liability.tax.output` credit. */
  taxCredit: number;
  /** Customer-facing line total — the debit side (cash + receivable). */
  lineTotalSum: number;
}

/**
 * Build the period's journal: balanced double-entry records plus a monthly
 * by-account summary and a list of warnings for anything that could not be
 * classified.
 */
export async function journalExport(range: DateRange): Promise<JournalExport> {
  const { start, end } = rangeBounds(range);
  const entries: JournalEntry[] = [];
  const warnings: JournalWarning[] = [];

  // --- Sales & returns, from orders closed in the period ---

  const orderRows: OrderRow[] = await db
    .select({
      id: orders.id,
      displayNumber: orders.displayNumber,
      closedAt: orders.closedAt,
      customerId: orders.customerId,
      snapshotCustomerName: orders.snapshotCustomerName,
      returnOfOrderId: orders.returnOfOrderId,
    })
    .from(orders)
    .where(
      and(
        isNull(orders.cancelledAt),
        gte(orders.closedAt, start),
        lte(orders.closedAt, end),
      ),
    );
  const orderById = new Map(orderRows.map((o) => [o.id, o]));

  const itemRows = await db
    .select({
      orderId: orderItems.orderId,
      qty: orderItems.qty,
      discountMinor: orderItems.discountMinor,
      priceMinor: orderItems.snapshotPriceMinor,
      taxRateBps: orderItems.snapshotTaxRateBps,
      priceMode: orderItems.snapshotPriceMode,
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

  const paymentRows = await db
    .select({
      orderId: orderPayments.orderId,
      amountMinor: orderPayments.amountMinor,
    })
    .from(orderPayments)
    .innerJoin(orders, eq(orderPayments.orderId, orders.id))
    .where(
      and(
        isNull(orders.cancelledAt),
        gte(orders.closedAt, start),
        lte(orders.closedAt, end),
      ),
    );

  const accByOrder = new Map<string, OrderAccumulator>();
  for (const it of itemRows) {
    const gross = it.priceMinor * it.qty;
    const discount = it.discountMinor;
    const netCharged = gross - discount;
    const { taxMinor, netRevenueMinor } = splitTax(
      netCharged,
      it.taxRateBps,
      it.priceMode,
    );
    const lineTotal =
      it.priceMode === "tax_inclusive" ? netCharged : netCharged + taxMinor;
    const a = accByOrder.get(it.orderId) ?? {
      revenueCredit: 0,
      discountDebit: 0,
      taxCredit: 0,
      lineTotalSum: 0,
    };
    a.revenueCredit += netRevenueMinor + discount;
    a.discountDebit += discount;
    a.taxCredit += taxMinor;
    a.lineTotalSum += lineTotal;
    accByOrder.set(it.orderId, a);
  }

  const cashByOrder = new Map<string, number>();
  for (const p of paymentRows) {
    cashByOrder.set(p.orderId, (cashByOrder.get(p.orderId) ?? 0) + p.amountMinor);
  }

  for (const o of orderRows) {
    const a = accByOrder.get(o.id);
    if (!a) continue; // no live items — nothing to recognise
    const cash = cashByOrder.get(o.id) ?? 0;
    const receivable = a.lineTotalSum - cash;
    const hasParty = o.customerId !== null || o.snapshotCustomerName !== null;
    if (receivable !== 0 && !hasParty) {
      warnings.push({
        kind: "unpaid_walk_in_sale",
        refType: "order",
        refId: o.id,
        message: `order ${o.displayNumber ?? o.id} carries a ${receivable} unpaid balance but has no customer`,
      });
    }
    emitEntry(
      entries,
      warnings,
      {
        date: (o.closedAt as Date).toISOString(),
        refType: "order",
        refId: o.id,
        description: `${o.returnOfOrderId ? "Return" : "Sale"} ${o.displayNumber ?? o.id}`,
        partyType: hasParty ? "customer" : null,
        partyId: o.customerId,
        partyName: o.snapshotCustomerName,
      },
      [
        { category: "asset.cash", amountMinor: cash },
        { category: "asset.receivable", amountMinor: receivable },
        { category: "revenue.sales", amountMinor: -a.revenueCredit },
        { category: "revenue.sales.discount", amountMinor: a.discountDebit },
        { category: "liability.tax.output", amountMinor: -a.taxCredit },
      ],
    );
  }

  // --- COGS, receiving & inventory loss, from stock_movements ---

  const movementRows = await db
    .select({
      type: stockMovements.type,
      qtyDelta: stockMovements.qtyDelta,
      unitCost: stockMovements.unitCost,
      refId: stockMovements.refId,
      createdAt: stockMovements.createdAt,
    })
    .from(stockMovements)
    .where(
      and(
        gte(stockMovements.createdAt, start),
        lte(stockMovements.createdAt, end),
      ),
    );

  // COGS aggregates by order; receiving aggregates by delivery.
  const cogsByOrder = new Map<string, { amountMinor: number; latest: Date }>();
  const receiveByDelivery = new Map<string, { amountMinor: number; latest: Date }>();
  const bump = (
    map: Map<string, { amountMinor: number; latest: Date }>,
    key: string,
    amountMinor: number,
    at: Date,
  ): void => {
    const g = map.get(key) ?? { amountMinor: 0, latest: at };
    g.amountMinor += amountMinor;
    if (at > g.latest) g.latest = at;
    map.set(key, g);
  };

  for (const m of movementRows) {
    if (m.type === "sale" || m.type === "sale_return") {
      // COGS = WAC × units leaving (qtyDelta is negative on a sale).
      if (!m.refId) continue;
      bump(cogsByOrder, m.refId, -m.qtyDelta * m.unitCost, m.createdAt);
    } else if (m.type === "purchase_receive") {
      if (!m.refId) continue;
      bump(receiveByDelivery, m.refId, m.qtyDelta * m.unitCost, m.createdAt);
    } else if (m.type === "adjustment_in" || m.type === "adjustment_out") {
      warnings.push({
        kind: "untagged_adjustment",
        refType: "stock_movement",
        refId: m.refId ?? undefined,
        message: `stock ${m.type} (value ${m.qtyDelta * m.unitCost}) needs an account_category — inventory-loss tagging is deferred`,
      });
    } else if (m.type === "initial_import") {
      warnings.push({
        kind: "unclassified",
        refType: "stock_movement",
        refId: m.refId ?? undefined,
        message: "initial_import movement is not exported — opening inventory has no journal source",
      });
    }
    // transfer_in / transfer_out / cost_override: internal, no journal effect.
  }

  for (const [orderId, g] of cogsByOrder) {
    const o = orderById.get(orderId);
    const hasParty = !!o && (o.customerId !== null || o.snapshotCustomerName !== null);
    emitEntry(
      entries,
      warnings,
      {
        date: (o?.closedAt ?? g.latest).toISOString(),
        refType: "order",
        refId: orderId,
        description: `COGS ${o?.displayNumber ?? orderId}`,
        partyType: hasParty ? "customer" : null,
        partyId: o?.customerId ?? null,
        partyName: o?.snapshotCustomerName ?? null,
      },
      [
        { category: "cogs.product", amountMinor: g.amountMinor },
        { category: "asset.inventory", amountMinor: -g.amountMinor },
      ],
    );
  }

  // Receiving raises AP. The credit is sourced from the vendor ledger's
  // `purchase_on_account` rows (so the export aggregate matches the operational
  // AP, capturing both the supplier and any tagged expedition); the debit is
  // the capitalized inventory from the receive movements. The two agree exactly
  // for the common cases (goods only, or goods + courier-tagged freight). Any
  // residual is a known deferral that balances to a plug line and is flagged:
  // recorded payable above inventory is non-stock purchase value (expensed);
  // inventory above payable is ad-hoc or untagged freight (credited to payable).
  const apRows = await db
    .select({ deliveryId: vendorLedger.refId, amountMinor: vendorLedger.amountMinor })
    .from(vendorLedger)
    .where(
      and(
        eq(vendorLedger.type, "purchase_on_account"),
        eq(vendorLedger.refType, "purchase_delivery"),
        gte(vendorLedger.createdAt, start),
        lte(vendorLedger.createdAt, end),
      ),
    );
  const apByDelivery = new Map<string, number>();
  for (const r of apRows) {
    if (!r.deliveryId) continue;
    apByDelivery.set(r.deliveryId, (apByDelivery.get(r.deliveryId) ?? 0) + r.amountMinor);
  }

  const deliveryIds = [
    ...new Set([...receiveByDelivery.keys(), ...apByDelivery.keys()]),
  ];
  const deliveryRows = deliveryIds.length
    ? await db
        .select({
          id: purchaseDeliveries.id,
          purchaseId: purchaseDeliveries.purchaseId,
          deliveredAt: purchaseDeliveries.deliveredAt,
        })
        .from(purchaseDeliveries)
        .where(inArray(purchaseDeliveries.id, deliveryIds))
    : [];
  const deliveryById = new Map(deliveryRows.map((d) => [d.id, d]));
  const purchaseIds = [
    ...new Set(
      deliveryRows
        .map((d) => d.purchaseId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const purchaseRows = purchaseIds.length
    ? await db
        .select({
          id: purchases.id,
          vendorId: purchases.vendorId,
          snapshotVendorName: purchases.snapshotVendorName,
        })
        .from(purchases)
        .where(inArray(purchases.id, purchaseIds))
    : [];
  const purchaseById = new Map(purchaseRows.map((p) => [p.id, p]));

  for (const deliveryId of deliveryIds) {
    const d = deliveryById.get(deliveryId);
    const p = d?.purchaseId ? purchaseById.get(d.purchaseId) : undefined;
    const inventory = receiveByDelivery.get(deliveryId)?.amountMinor ?? 0;
    const apCredit = apByDelivery.get(deliveryId) ?? 0;
    const postings: Posting[] = [
      { category: "asset.inventory", amountMinor: inventory },
      { category: "liability.payable", amountMinor: -apCredit },
    ];
    const residual = inventory - apCredit;
    if (residual > 0) {
      postings.push({ category: "liability.payable", amountMinor: -residual });
      warnings.push({
        kind: "receiving_residual",
        refType: "purchase_delivery",
        refId: deliveryId,
        message: `delivery ${deliveryId}: ${residual} of goods received has no recorded payable (ad-hoc purchase or untagged freight) — credited to payable`,
      });
    } else if (residual < 0) {
      postings.push({ category: "expense.other", amountMinor: -residual });
      warnings.push({
        kind: "untagged_expense",
        refType: "purchase_delivery",
        refId: deliveryId,
        message: `delivery ${deliveryId}: ${-residual} of non-stock purchase value expensed to expense.other — needs a specific expense category`,
      });
    }
    emitEntry(
      entries,
      warnings,
      {
        date: (
          d?.deliveredAt ??
          receiveByDelivery.get(deliveryId)?.latest ??
          end
        ).toISOString(),
        refType: "purchase_delivery",
        refId: deliveryId,
        description: `Goods received ${deliveryId}`,
        partyType: p ? "vendor" : null,
        partyId: p?.vendorId ?? null,
        partyName: p?.snapshotVendorName ?? null,
      },
      postings,
    );
  }

  // --- Customer payments (AR settlement) ---

  const custLedgerRows = await db
    .select({
      id: customerLedger.id,
      customerId: customerLedger.customerId,
      type: customerLedger.type,
      amountMinor: customerLedger.amountMinor,
      createdAt: customerLedger.createdAt,
      name: customers.name,
    })
    .from(customerLedger)
    .innerJoin(customers, eq(customerLedger.customerId, customers.id))
    .where(
      and(
        gte(customerLedger.createdAt, start),
        lte(customerLedger.createdAt, end),
      ),
    );
  for (const r of custLedgerRows) {
    if (r.type === "payment") {
      // amountMinor is negative on a payment — cash in, receivable down.
      emitEntry(
        entries,
        warnings,
        {
          date: r.createdAt.toISOString(),
          refType: "customer_payment",
          refId: r.id,
          description: `Payment from ${r.name}`,
          partyType: "customer",
          partyId: r.customerId,
          partyName: r.name,
        },
        [
          { category: "asset.cash", amountMinor: -r.amountMinor },
          { category: "asset.receivable", amountMinor: r.amountMinor },
        ],
      );
    } else if (r.type === "adjustment") {
      warnings.push({
        kind: "untagged_adjustment",
        refType: "customer_ledger",
        refId: r.id,
        message: `customer adjustment for ${r.name} (${r.amountMinor}) needs an account_category — adjustment tagging is deferred`,
      });
    } else if (r.type === "opening_balance") {
      warnings.push({
        kind: "unclassified",
        refType: "customer_ledger",
        refId: r.id,
        message: `customer opening_balance for ${r.name} is not exported — no equity account in the catalog`,
      });
    }
    // sale_on_account / refund_credit: already captured by the order entries.
  }

  // --- Vendor payments (AP settlement) ---

  const vendLedgerRows = await db
    .select({
      id: vendorLedger.id,
      vendorId: vendorLedger.vendorId,
      type: vendorLedger.type,
      amountMinor: vendorLedger.amountMinor,
      createdAt: vendorLedger.createdAt,
      name: vendors.name,
    })
    .from(vendorLedger)
    .innerJoin(vendors, eq(vendorLedger.vendorId, vendors.id))
    .where(
      and(gte(vendorLedger.createdAt, start), lte(vendorLedger.createdAt, end)),
    );
  for (const r of vendLedgerRows) {
    if (r.type === "payment") {
      // amountMinor is negative on a payment — payable down, cash out.
      emitEntry(
        entries,
        warnings,
        {
          date: r.createdAt.toISOString(),
          refType: "vendor_payment",
          refId: r.id,
          description: `Payment to ${r.name}`,
          partyType: "vendor",
          partyId: r.vendorId,
          partyName: r.name,
        },
        [
          { category: "liability.payable", amountMinor: -r.amountMinor },
          { category: "asset.cash", amountMinor: r.amountMinor },
        ],
      );
    } else if (r.type === "adjustment") {
      warnings.push({
        kind: "untagged_adjustment",
        refType: "vendor_ledger",
        refId: r.id,
        message: `vendor adjustment for ${r.name} (${r.amountMinor}) needs an account_category — adjustment tagging is deferred`,
      });
    } else if (r.type === "opening_balance") {
      warnings.push({
        kind: "unclassified",
        refType: "vendor_ledger",
        refId: r.id,
        message: `vendor opening_balance for ${r.name} is not exported — no equity account in the catalog`,
      });
    } else if (r.type === "refund_credit") {
      // Most refund_credit rows are delivery cancellations; reversing them in
      // the journal also requires reversing the stock side (adjustment_out),
      // which is itself a deferred/warned case — so flag rather than half-post.
      warnings.push({
        kind: "uncaptured_reversal",
        refType: "vendor_ledger",
        refId: r.id,
        message: `vendor refund_credit for ${r.name} (${r.amountMinor}) is not exported — delivery-cancellation reversal journaling is deferred`,
      });
    }
    // purchase_on_account: captured by the receiving entries above.
  }

  // --- Tracking-account ledger (commissions, draws, internal funds) ---
  // The account carries its own category pair, so every type but
  // opening_balance is fully classifiable without a schema tag.

  const trackingRows = await db
    .select({
      id: trackingAccountLedger.id,
      type: trackingAccountLedger.type,
      amountMinor: trackingAccountLedger.amountMinor,
      counterOverride: trackingAccountLedger.counterCategoryOverride,
      createdAt: trackingAccountLedger.createdAt,
      accountName: trackingAccounts.name,
      accountCategory: trackingAccounts.accountCategory,
      counterCategory: trackingAccounts.counterCategory,
    })
    .from(trackingAccountLedger)
    .innerJoin(
      trackingAccounts,
      eq(trackingAccountLedger.trackingAccountId, trackingAccounts.id),
    )
    .where(
      and(
        gte(trackingAccountLedger.createdAt, start),
        lte(trackingAccountLedger.createdAt, end),
      ),
    );
  for (const r of trackingRows) {
    const amt = r.amountMinor;
    let postings: Posting[];
    if (r.type === "attribution") {
      postings = [
        { category: r.counterCategory, amountMinor: amt },
        { category: r.accountCategory, amountMinor: -amt },
      ];
    } else if (r.type === "deposit") {
      postings = [
        { category: "asset.cash", amountMinor: amt },
        { category: r.accountCategory, amountMinor: -amt },
      ];
    } else if (r.type === "payout") {
      // amountMinor is negative — the account balance is drawn down.
      postings = [
        { category: r.accountCategory, amountMinor: -amt },
        { category: "asset.cash", amountMinor: amt },
      ];
    } else if (r.type === "adjustment") {
      const counter = r.counterOverride ?? r.counterCategory;
      postings = [
        { category: counter, amountMinor: amt },
        { category: r.accountCategory, amountMinor: -amt },
      ];
    } else {
      warnings.push({
        kind: "unclassified",
        refType: "tracking_account_ledger",
        refId: r.id,
        message: `tracking opening_balance for ${r.accountName} is not exported — no equity account in the catalog`,
      });
      continue;
    }
    emitEntry(
      entries,
      warnings,
      {
        date: r.createdAt.toISOString(),
        refType: `tracking_${r.type}`,
        refId: r.id,
        description: `Tracking ${r.type} — ${r.accountName}`,
        partyType: null,
        partyId: null,
        partyName: r.accountName,
      },
      postings,
    );
  }

  // --- Non-stock purchase lines delivered in the period ---
  // They write no stock movement and carry no account_category yet, so the
  // expense they represent cannot be classified — flag each one.

  const nonStockRows = await db
    .select({
      itemId: purchaseItems.id,
      description: purchaseItems.description,
      costMinor: purchaseDeliveryItems.costMinor,
      deliveryId: purchaseDeliveries.id,
    })
    .from(purchaseDeliveryItems)
    .innerJoin(
      purchaseDeliveries,
      eq(purchaseDeliveryItems.deliveryId, purchaseDeliveries.id),
    )
    .innerJoin(
      purchaseItems,
      eq(purchaseDeliveryItems.purchaseItemId, purchaseItems.id),
    )
    .where(
      and(
        eq(purchaseDeliveries.status, "delivered"),
        isNull(purchaseItems.variantId),
        gte(purchaseDeliveries.deliveredAt, start),
        lte(purchaseDeliveries.deliveredAt, end),
      ),
    );
  for (const r of nonStockRows) {
    warnings.push({
      kind: "untagged_nonstock_purchase",
      refType: "purchase_delivery",
      refId: r.deliveryId,
      message: `non-stock purchase line "${r.description ?? r.itemId}" (cost ${r.costMinor}) needs an account_category — expense tagging is deferred`,
    });
  }

  // --- Validate categories, order, summarise ---

  // Tracking accounts carry free-text categories; flag any outside the catalog.
  for (const entry of entries) {
    for (const line of entry.lines) {
      if (!isKnownAccountCategory(line.accountCategory)) {
        warnings.push({
          kind: "unknown_account_category",
          refType: entry.refType,
          refId: entry.refId,
          message: `account category "${line.accountCategory}" is not in the catalog`,
        });
      }
    }
  }

  entries.sort(
    (a, b) => a.date.localeCompare(b.date) || a.refId.localeCompare(b.refId),
  );

  const summaryMap = new Map<string, JournalSummaryRow>();
  for (const entry of entries) {
    const month = entry.date.slice(0, 7);
    for (const line of entry.lines) {
      const key = `${month}|${line.accountCategory}`;
      const row = summaryMap.get(key) ?? {
        month,
        accountCategory: line.accountCategory,
        debitTotalMinor: 0,
        creditTotalMinor: 0,
      };
      row.debitTotalMinor += line.debitMinor;
      row.creditTotalMinor += line.creditMinor;
      summaryMap.set(key, row);
    }
  }
  const summary = [...summaryMap.values()].sort(
    (a, b) =>
      a.month.localeCompare(b.month) ||
      a.accountCategory.localeCompare(b.accountCategory),
  );

  return {
    periodStart: range.periodStart,
    periodEnd: range.periodEnd,
    entries,
    summary,
    warnings,
  };
}

// --- CSV presentation ---

/** `minor` ships raw integer minor units; `major` divides by 100 (2 dp). */
export type JournalCurrency = "minor" | "major";

function formatAmount(minor: number, currency: JournalCurrency): string {
  return currency === "major" ? (minor / 100).toFixed(2) : String(minor);
}

/** Quote a CSV field when it contains a comma, quote, or newline. */
function csvField(value: string | number): string {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(fields: (string | number)[]): string {
  return fields.map(csvField).join(",");
}

/**
 * `journal.csv` — one row per debit/credit line. GnuCash imports this with
 * its multi-split CSV importer.
 */
export function toJournalCsv(data: JournalExport, currency: JournalCurrency): string {
  const rows = [
    csvRow(["date", "ref", "description", "party", "account", "debit", "credit"]),
  ];
  for (const entry of data.entries) {
    for (const line of entry.lines) {
      rows.push(
        csvRow([
          entry.date.slice(0, 10),
          `${entry.refType}:${entry.refId}`,
          entry.description,
          entry.partyName ?? "",
          line.accountCategory,
          line.debitMinor === 0 ? "" : formatAmount(line.debitMinor, currency),
          line.creditMinor === 0 ? "" : formatAmount(line.creditMinor, currency),
        ]),
      );
    }
  }
  return `${rows.join("\r\n")}\r\n`;
}

/** `summary.csv` — one row per (month × account) for manual monthly entry. */
export function toSummaryCsv(data: JournalExport, currency: JournalCurrency): string {
  const rows = [csvRow(["month", "account", "debit_total", "credit_total"])];
  for (const r of data.summary) {
    rows.push(
      csvRow([
        r.month,
        r.accountCategory,
        formatAmount(r.debitTotalMinor, currency),
        formatAmount(r.creditTotalMinor, currency),
      ]),
    );
  }
  return `${rows.join("\r\n")}\r\n`;
}
