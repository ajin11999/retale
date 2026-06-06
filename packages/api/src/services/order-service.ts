// Order service. Stage 1: `createPosOrder` — the atomic POS sale. One
// transaction writes the order, its snapshotted items, stock movements,
// payments, and a customer_ledger row for any unpaid remainder. Console
// customer sales and returns are later stages.
// See docs/design-decisions.md → "Order lifecycle" and "Payments & customer
// debt".

import { and, desc, eq, gt, inArray, isNotNull, isNull, like, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { customerLedger, customerPrices, customers } from "../db/schema/customers.ts";
import { orderItems, orderPayments, orders } from "../db/schema/orders.ts";
import { pointsOfSale, posSessions } from "../db/schema/pos.ts";
import {
  bundleComponents,
  productCategories,
  productPriceTiers,
  products,
  productVariants,
} from "../db/schema/products.ts";
import {
  trackingAccountLedger,
  trackingAccounts,
} from "../db/schema/tracking.ts";
import { db } from "../lib/db.ts";
import { modifyStock } from "./stock-service.ts";

export type OrderErrorCode =
  | "ORDER_NOT_FOUND"
  | "SESSION_NOT_FOUND"
  | "SESSION_CLOSED"
  | "CUSTOMER_NOT_FOUND"
  | "VARIANT_NOT_FOUND"
  | "INVALID_INPUT"
  | "EMPTY_ORDER"
  | "PRICE_OVERRIDE_NOT_ALLOWED"
  | "OPEN_PRICE_REQUIRES_PRICE"
  | "WALKIN_NOT_FULLY_PAID"
  | "OVERPAID"
  | "CREDIT_LIMIT_EXCEEDED"
  | "ORDER_CLOSED"
  | "ORDER_CANCELLED"
  | "ITEM_NOT_FOUND"
  | "ITEM_ALREADY_VOIDED"
  | "ORDER_NOT_CLOSED"
  | "CANNOT_RETURN_RETURN"
  | "NOTHING_TO_RETURN"
  | "RETURN_QTY_EXCEEDED"
  | "STORE_CREDIT_NEEDS_CUSTOMER";

export class OrderError extends Error {
  constructor(
    public code: OrderErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "OrderError";
  }
}

type Order = typeof orders.$inferSelect;
type OrderItem = typeof orderItems.$inferSelect;
type OrderPayment = typeof orderPayments.$inferSelect;
type Variant = typeof productVariants.$inferSelect;
type Product = typeof products.$inferSelect;

/** A drizzle transaction handle; structurally a subset of `db`. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface PosOrderItemInput {
  variantId: string;
  /** Integer count of the variant's smallest unit; must be positive. */
  qty: number;
  /** Fixed per-line discount, minor units. Defaults to 0. */
  discountMinor?: number;
  /** Allowed only for `kind = 'service'` products. */
  priceOverrideMinor?: number | null;
  /**
   * Replaces the computed tracking-account attribution for this line.
   * Requires the variant to carry a tracking account; the caller must hold
   * the `order.attribute` permission.
   */
  attributionAmountOverrideMinor?: number | null;
}

export interface PosOrderPaymentInput {
  /** Cash-only for v1; defaults to "cash". */
  method?: "cash";
  amountMinor: number;
}

// --- Queries ---

export async function getOrder(id: string): Promise<Order> {
  const row = await db.query.orders.findFirst({ where: eq(orders.id, id) });
  if (!row) throw new OrderError("ORDER_NOT_FOUND");
  return row;
}

export function listOrders(filter?: {
  posSessionId?: string;
  customerId?: string;
  limit?: number;
}): Promise<Order[]> {
  const conds = [];
  if (filter?.posSessionId) conds.push(eq(orders.posSessionId, filter.posSessionId));
  if (filter?.customerId) conds.push(eq(orders.customerId, filter.customerId));
  return db
    .select()
    .from(orders)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(orders.createdAt))
    .limit(Math.min(Math.max(filter?.limit ?? 100, 1), 500));
}

export function listOrderItems(orderId: string): Promise<OrderItem[]> {
  return db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
}

/**
 * Closed, non-return orders that contain *every* one of `variantIds` on a
 * non-voided, positive-qty line — newest first. Drives the POS return-from-cart
 * picker: the cashier builds a cart of items to send back, and this surfaces the
 * past sale(s) those items could have come from. Per-variant quantity coverage
 * is judged on the client; `createReturn` enforces over-return at submit.
 */
export async function listOrdersForReturn(
  variantIds: string[],
  limit = 50,
): Promise<Order[]> {
  if (variantIds.length === 0) return [];
  // Orders whose lines cover all of the requested variants.
  const matched = await db
    .select({ orderId: orderItems.orderId })
    .from(orderItems)
    .where(
      and(
        inArray(orderItems.variantId, variantIds),
        isNull(orderItems.voidedAt),
        gt(orderItems.qty, 0),
      ),
    )
    .groupBy(orderItems.orderId)
    .having(sql`count(distinct ${orderItems.variantId}) = ${variantIds.length}`);
  const ids = matched.map((m) => m.orderId);
  if (ids.length === 0) return [];
  // Keep only returnable orders: closed, not cancelled, not themselves returns.
  return db
    .select()
    .from(orders)
    .where(
      and(
        inArray(orders.id, ids),
        isNotNull(orders.closedAt),
        isNull(orders.cancelledAt),
        isNull(orders.returnOfOrderId),
      ),
    )
    .orderBy(desc(orders.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
}

/** The live variant behind a line, if it still exists (null after a hard-delete). */
export async function getLineVariant(variantId: string): Promise<Variant | null> {
  const row = await db.query.productVariants.findFirst({
    where: eq(productVariants.id, variantId),
  });
  return row ?? null;
}

export function listOrderPayments(orderId: string): Promise<OrderPayment[]> {
  return db.select().from(orderPayments).where(eq(orderPayments.orderId, orderId));
}

/** Derived order status — never stored. See design-decisions.md. */
export function orderStatus(o: Order): "open" | "closed" | "cancelled" {
  if (o.cancelledAt) return "cancelled";
  return o.closedAt ? "closed" : "open";
}

/** Recompute a customer's cached `balanceMinor` from the ledger SUM. */
async function syncCustomerBalance(tx: Tx, customerId: string): Promise<void> {
  const sums = await tx
    .select({
      total: sql<number>`COALESCE(SUM(${customerLedger.amountMinor}), 0)`,
    })
    .from(customerLedger)
    .where(eq(customerLedger.customerId, customerId));
  await tx
    .update(customers)
    .set({ balanceMinor: Number(sums[0]?.total ?? 0) })
    .where(eq(customers.id, customerId));
}

/** A non-voided line's total: qty * price - discount. */
function lineTotalOf(i: OrderItem): number {
  return i.qty * i.snapshotPriceMinor - i.discountMinor;
}

/** Recompute and store `orders.totalMinor` from the order's live (non-voided) lines. */
async function recomputeOrderTotal(tx: Tx, orderId: string): Promise<number> {
  const items = await tx
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));
  const total = items
    .filter((i) => !i.voidedAt)
    .reduce((sum, i) => sum + lineTotalOf(i), 0);
  await tx.update(orders).set({ totalMinor: total }).where(eq(orders.id, orderId));
  return total;
}

// --- POS order creation ---

/** Local-time `YYYY-MM-DD` stamp for the daily display-number sequence. */
function dateStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Next `<posCode>-<date>-<seq>` display number. The daily sequence resets at
 * midnight per POS. The unique index on `orders.display_number` is the
 * race-safe backstop; concurrent creates on one POS are not expected at
 * retail scale.
 */
async function nextDisplayNumber(tx: Tx, posCode: string): Promise<string> {
  const prefix = `${posCode}-${dateStamp()}-`;
  const rows = await tx
    .select({ dn: orders.displayNumber })
    .from(orders)
    .where(like(orders.displayNumber, `${prefix}%`));
  let max = 0;
  for (const r of rows) {
    const seq = Number(r.dn?.slice(prefix.length));
    if (Number.isInteger(seq) && seq > max) max = seq;
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

/**
 * Resolve the per-unit price for a variant: a customer override wins, then the
 * highest qty-break tier at or below `qty`, then the variant base price.
 */
async function resolvePrice(
  tx: Tx,
  variant: Variant,
  customerId: string | null,
  qty: number,
): Promise<number> {
  if (customerId) {
    const override = await tx.query.customerPrices.findFirst({
      where: and(
        eq(customerPrices.customerId, customerId),
        eq(customerPrices.variantId, variant.id),
      ),
    });
    if (override) return override.priceMinor;
  }
  const tiers = await tx
    .select()
    .from(productPriceTiers)
    .where(eq(productPriceTiers.variantId, variant.id));
  const best = tiers
    .filter((t) => t.minQty <= qty)
    .sort((a, b) => b.minQty - a.minQty)[0];
  return best ? best.priceMinor : variant.priceMinor;
}

/**
 * Tracking-account attribution for a line: the mechanic's cut falls on the
 * pre-tax goods/service revenue — never on tax, never on a discount the
 * business absorbed. `qty` may be negative (return lines), yielding a negative
 * attribution. See docs/design-decisions.md → "Attribution compute formula".
 */
function computeAttribution(args: {
  priceMinor: number;
  qty: number;
  discountMinor: number;
  priceMode: "tax_inclusive" | "tax_exclusive";
  taxRateBps: number;
  mode: "full" | "percent";
  pctBps: number | null;
}): number {
  const gross = args.priceMinor * args.qty - args.discountMinor;
  const preTax =
    args.priceMode === "tax_exclusive"
      ? gross
      : Math.round((gross * 10000) / (10000 + args.taxRateBps));
  if (args.mode === "full") return preTax;
  return Math.round((preTax * (args.pctBps ?? 0)) / 10000);
}

/** Built order_items insert row plus the computed line total. */
interface BuiltLine {
  row: typeof orderItems.$inferInsert;
  lineTotal: number;
  isPhysical: boolean;
}

/**
 * Assemble one order_items row from an already-resolved price and discount.
 * Shared by ordinary lines and the component lines a bundle explodes into.
 */
async function buildSnapshotRow(opts: {
  tx: Tx;
  orderId: string;
  variant: Variant;
  product: Product;
  qty: number;
  priceMinor: number;
  discountMinor: number;
  bundleName: string | null;
  attributionOverrideMinor?: number | null;
}): Promise<BuiltLine> {
  const { tx, variant, product, qty, priceMinor, discountMinor } = opts;
  const lineTotal = qty * priceMinor - discountMinor;
  if (lineTotal < 0) {
    throw new OrderError("INVALID_INPUT", "discount exceeds the line subtotal");
  }

  const category = product.categoryId
    ? await tx.query.productCategories.findFirst({
        where: eq(productCategories.id, product.categoryId),
      })
    : null;

  // Tracking-account attribution: snapshotted on the line at sale time. The
  // ledger row is posted separately (POS: on create; Console: on close).
  let attributionAccountId: string | null = null;
  let attributionAmountMinor = 0;
  let trackingAccountName: string | null = null;
  if (variant.trackingAccountId) {
    const account = await tx.query.trackingAccounts.findFirst({
      where: eq(trackingAccounts.id, variant.trackingAccountId),
    });
    attributionAccountId = variant.trackingAccountId;
    trackingAccountName = account?.name ?? null;
    attributionAmountMinor = computeAttribution({
      priceMinor,
      qty,
      discountMinor,
      priceMode: product.priceMode,
      taxRateBps: product.taxRateBps,
      mode: variant.trackingAttributionMode,
      pctBps: variant.trackingAttributionPctBps,
    });
  }
  if (opts.attributionOverrideMinor != null) {
    if (!attributionAccountId) {
      throw new OrderError(
        "INVALID_INPUT",
        "attribution override requires a tracking account on the variant",
      );
    }
    if (!Number.isInteger(opts.attributionOverrideMinor)) {
      throw new OrderError("INVALID_INPUT", "attribution override must be an integer");
    }
    attributionAmountMinor = opts.attributionOverrideMinor;
  }

  return {
    isPhysical: product.kind === "physical",
    lineTotal,
    row: {
      id: ulid(),
      orderId: opts.orderId,
      variantId: variant.id,
      productId: product.id,
      qty,
      discountMinor,
      snapshotProductName: product.name,
      snapshotPublicName: product.publicName,
      snapshotProductSku: variant.sku,
      snapshotProductBarcode: variant.barcode,
      snapshotVariantLabel: variant.label,
      snapshotUnit: variant.unit,
      snapshotCategoryName: category?.name ?? null,
      snapshotPriceMinor: priceMinor,
      snapshotCostMinor:
        product.kind === "service"
          ? 0
          : product.kind === "open_price"
            ? Math.round((priceMinor * (product.costRatioBps ?? 0)) / 10000)
            : variant.costMinor,
      snapshotTaxRateBps: product.taxRateBps,
      snapshotPriceMode: product.priceMode,
      snapshotTrackingAccountName: trackingAccountName,
      snapshotBundleName: opts.bundleName,
      attributionAccountId,
      attributionAmountMinor,
    },
  };
}

/**
 * Explode a bundle line into one order line per component. The bundle's price
 * is distributed across components by their natural value (unit price × qty);
 * each component shows its own unit price, with its share of the bundle saving
 * as the line discount, so the component totals sum exactly to the bundle
 * price. Stock and attribution then fall out per real component.
 */
async function buildBundleLines(opts: {
  tx: Tx;
  orderId: string;
  item: PosOrderItemInput;
  customerId: string | null;
  bundleVariant: Variant;
  bundleProduct: Product;
  discountMinor: number;
}): Promise<BuiltLine[]> {
  const { tx, orderId, item, bundleVariant, bundleProduct } = opts;
  if (item.priceOverrideMinor != null) {
    throw new OrderError("PRICE_OVERRIDE_NOT_ALLOWED", "price overrides are not allowed on bundles");
  }
  if (item.attributionAmountOverrideMinor != null) {
    throw new OrderError("INVALID_INPUT", "attribution override is not supported on bundle lines");
  }

  const bundlePrice = await resolvePrice(tx, bundleVariant, opts.customerId, item.qty);
  const target = bundlePrice * item.qty - opts.discountMinor;
  if (target < 0) throw new OrderError("INVALID_INPUT", "discount exceeds the bundle price");

  const components = await tx
    .select()
    .from(bundleComponents)
    .where(eq(bundleComponents.bundleVariantId, bundleVariant.id));
  if (components.length === 0) {
    throw new OrderError("INVALID_INPUT", "bundle has no components");
  }

  // Resolve each component and its natural value (own unit price × line qty).
  const parts: { variant: Variant; product: Product; qty: number; value: number }[] = [];
  for (const c of components) {
    const cv = await tx.query.productVariants.findFirst({
      where: eq(productVariants.id, c.componentVariantId),
    });
    if (!cv) throw new OrderError("VARIANT_NOT_FOUND", c.componentVariantId);
    const cp = await tx.query.products.findFirst({ where: eq(products.id, cv.productId) });
    if (!cp) throw new OrderError("VARIANT_NOT_FOUND", c.componentVariantId);
    const lineQty = c.qty * item.qty;
    parts.push({ variant: cv, product: cp, qty: lineQty, value: cv.priceMinor * lineQty });
  }

  // Distribute `target` over the components: floor each proportional share,
  // then hand the rounding remainder out one unit at a time. Sums exactly.
  const totalValue = parts.reduce((sum, p) => sum + p.value, 0);
  let shares: number[];
  if (totalValue > 0) {
    const floors = parts.map((p) => Math.floor((target * p.value) / totalValue));
    const remainder = target - floors.reduce((a, b) => a + b, 0);
    shares = floors.map((f, i) => f + (i < remainder ? 1 : 0));
  } else {
    // Zero-value components — put the whole price on the last line.
    shares = parts.map((_, i) => (i === parts.length - 1 ? target : 0));
  }

  const lines: BuiltLine[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    lines.push(
      await buildSnapshotRow({
        tx,
        orderId,
        variant: p.variant,
        product: p.product,
        qty: p.qty,
        priceMinor: p.variant.priceMinor,
        discountMinor: p.value - shares[i]!,
        bundleName: bundleProduct.name,
      }),
    );
  }
  return lines;
}

/**
 * Build the order line(s) for one input item. An ordinary product yields a
 * single line; a `kind = 'bundle'` product explodes into its component lines.
 */
async function buildLines(
  tx: Tx,
  orderId: string,
  item: PosOrderItemInput,
  customerId: string | null,
): Promise<BuiltLine[]> {
  if (!Number.isInteger(item.qty) || item.qty <= 0) {
    throw new OrderError("INVALID_INPUT", "item qty must be a positive integer");
  }
  const discount = item.discountMinor ?? 0;
  if (!Number.isInteger(discount) || discount < 0) {
    throw new OrderError("INVALID_INPUT", "discount must be a non-negative integer");
  }

  const variant = await tx.query.productVariants.findFirst({
    where: eq(productVariants.id, item.variantId),
  });
  if (!variant) throw new OrderError("VARIANT_NOT_FOUND", item.variantId);
  const product = await tx.query.products.findFirst({
    where: eq(products.id, variant.productId),
  });
  if (!product) throw new OrderError("VARIANT_NOT_FOUND", item.variantId);

  if (product.kind === "bundle") {
    return buildBundleLines({
      tx,
      orderId,
      item,
      customerId,
      bundleVariant: variant,
      bundleProduct: product,
      discountMinor: discount,
    });
  }

  // A cashier-entered price overrides the catalog/customer price on any line
  // (bundles excepted — handled above). Open-price items (loose hardware sold
  // by guess) have no base price, so an entered price is mandatory there.
  const isOpenPrice = product.kind === "open_price";
  let price: number;
  if (item.priceOverrideMinor != null) {
    if (!Number.isInteger(item.priceOverrideMinor) || item.priceOverrideMinor < 0) {
      throw new OrderError("INVALID_INPUT", "price override must be a non-negative integer");
    }
    price = item.priceOverrideMinor;
  } else if (isOpenPrice) {
    throw new OrderError("OPEN_PRICE_REQUIRES_PRICE", "open-price items require an entered price");
  } else {
    price = await resolvePrice(tx, variant, customerId, item.qty);
  }

  return [
    await buildSnapshotRow({
      tx,
      orderId,
      variant,
      product,
      qty: item.qty,
      priceMinor: price,
      discountMinor: discount,
      bundleName: null,
      attributionOverrideMinor: item.attributionAmountOverrideMinor,
    }),
  ];
}

/** Recompute a tracking account's cached `balanceMinor` from the ledger SUM. */
async function syncTrackingBalance(tx: Tx, accountId: string): Promise<void> {
  const sums = await tx
    .select({
      total: sql<number>`COALESCE(SUM(${trackingAccountLedger.amountMinor}), 0)`,
    })
    .from(trackingAccountLedger)
    .where(eq(trackingAccountLedger.trackingAccountId, accountId));
  await tx
    .update(trackingAccounts)
    .set({ balanceMinor: Number(sums[0]?.total ?? 0) })
    .where(eq(trackingAccounts.id, accountId));
}

/**
 * Post one `attribution` tracking_account_ledger row per non-voided line of an
 * order that carries an attribution account and a non-zero amount, then
 * re-sync each touched account's balance.
 */
async function postAttribution(
  tx: Tx,
  orderId: string,
  createdByUserId: string,
): Promise<void> {
  const items = await tx
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));
  const touched = new Set<string>();
  for (const item of items) {
    if (item.voidedAt) continue;
    if (!item.attributionAccountId || item.attributionAmountMinor === 0) continue;
    await tx.insert(trackingAccountLedger).values({
      id: ulid(),
      trackingAccountId: item.attributionAccountId,
      type: "attribution",
      amountMinor: item.attributionAmountMinor,
      refType: "order_item",
      refId: item.id,
      createdByUserId,
    });
    touched.add(item.attributionAccountId);
  }
  for (const accountId of touched) {
    await syncTrackingBalance(tx, accountId);
  }
}

/**
 * Create an atomic POS order: closed on create, tied to an open POS session.
 * Writes order, snapshotted items, stock movements (physical lines only),
 * payments, and a `sale_on_account` customer_ledger row for any unpaid
 * remainder. Walk-in orders (no customer) must be paid in full.
 */
export async function createPosOrder(input: {
  posSessionId: string;
  customerId?: string | null;
  items: PosOrderItemInput[];
  payments: PosOrderPaymentInput[];
  createdByUserId: string;
}): Promise<Order> {
  if (!input.items.length) throw new OrderError("EMPTY_ORDER");

  let paid = 0;
  for (const p of input.payments) {
    if (!Number.isInteger(p.amountMinor) || p.amountMinor <= 0) {
      throw new OrderError("INVALID_INPUT", "payment amount must be a positive integer");
    }
    paid += p.amountMinor;
  }

  return db.transaction(async (tx) => {
    const session = await tx.query.posSessions.findFirst({
      where: eq(posSessions.id, input.posSessionId),
    });
    if (!session) throw new OrderError("SESSION_NOT_FOUND");
    if (session.closedAt) throw new OrderError("SESSION_CLOSED");

    const pos = await tx.query.pointsOfSale.findFirst({
      where: eq(pointsOfSale.id, session.posId),
    });
    if (!pos) throw new OrderError("SESSION_NOT_FOUND");

    const customerId = input.customerId ?? null;
    const customer = customerId
      ? await tx.query.customers.findFirst({ where: eq(customers.id, customerId) })
      : null;
    if (customerId && !customer) throw new OrderError("CUSTOMER_NOT_FOUND");

    const orderId = ulid();
    const lines: BuiltLine[] = [];
    for (const item of input.items) {
      lines.push(...(await buildLines(tx, orderId, item, customerId)));
    }
    const total = lines.reduce((sum, l) => sum + l.lineTotal, 0);

    if (paid > total) {
      throw new OrderError("OVERPAID", "payments exceed the order total");
    }
    const remainder = total - paid;
    if (remainder > 0 && !customer) {
      throw new OrderError("WALKIN_NOT_FULLY_PAID");
    }
    if (
      remainder > 0 &&
      customer?.creditLimitMinor != null &&
      customer.balanceMinor + remainder > customer.creditLimitMinor
    ) {
      throw new OrderError("CREDIT_LIMIT_EXCEEDED");
    }

    const now = new Date();
    const displayNumber = await nextDisplayNumber(tx, pos.code);

    await tx.insert(orders).values({
      id: orderId,
      displayNumber,
      customerId,
      snapshotCustomerName: customer?.name ?? null,
      posSessionId: input.posSessionId,
      totalMinor: total,
      closedAt: now,
      closedByUserId: input.createdByUserId,
      createdByUserId: input.createdByUserId,
    });

    await tx.insert(orderItems).values(lines.map((l) => l.row));

    // Decrement stock for physical lines; services skip the ledger entirely.
    for (const line of lines) {
      if (!line.isPhysical) continue;
      await modifyStock(
        {
          variantId: line.row.variantId as string,
          type: "sale",
          qtyDelta: -(line.row.qty as number),
          refType: "order",
          refId: orderId,
          createdByUserId: input.createdByUserId,
        },
        tx,
      );
    }

    if (input.payments.length) {
      await tx.insert(orderPayments).values(
        input.payments.map((p) => ({
          id: ulid(),
          orderId,
          method: p.method ?? "cash",
          amountMinor: p.amountMinor,
          posSessionId: input.posSessionId,
          createdByUserId: input.createdByUserId,
        })),
      );
    }

    if (remainder > 0 && customer) {
      await tx.insert(customerLedger).values({
        id: ulid(),
        customerId: customer.id,
        type: "sale_on_account",
        amountMinor: remainder,
        refType: "order",
        refId: orderId,
        posSessionId: input.posSessionId,
        createdByUserId: input.createdByUserId,
      });
      await syncCustomerBalance(tx, customer.id);
    }

    // POS orders attribute on create (the atomic "Pay" action).
    await postAttribution(tx, orderId, input.createdByUserId);

    const row = await tx.query.orders.findFirst({ where: eq(orders.id, orderId) });
    return row as Order;
  });
}

// --- Console customer sales (stateful open orders) ---
//
// Unlike POS orders, a Console sale is built up incrementally: each item add
// posts a `sale_on_account` customer_ledger row and each payment posts a
// `payment` row, so `customers.balanceMinor` always reflects the open sale.
// Voiding a line reverses both its stock movement and its ledger row.

/** Load an order that must still be open (not closed, not cancelled). */
async function loadOpenOrder(tx: Tx, id: string): Promise<Order> {
  const order = await tx.query.orders.findFirst({ where: eq(orders.id, id) });
  if (!order) throw new OrderError("ORDER_NOT_FOUND");
  if (order.cancelledAt) throw new OrderError("ORDER_CANCELLED");
  if (order.closedAt) throw new OrderError("ORDER_CLOSED");
  return order;
}

/** Trim a free-text note; collapse whitespace-only to null; cap at 1000 chars. */
function normalizeNote(note: string | null): string | null {
  if (note == null) return null;
  const trimmed = note.trim();
  if (trimmed === "") return null;
  if (trimmed.length > 1000) {
    throw new OrderError("INVALID_INPUT", "note must be 1000 characters or fewer");
  }
  return trimmed;
}

/** Open an empty Console customer sale for a customer. */
export async function createCustomerSale(input: {
  customerId: string;
  note?: string | null;
  createdByUserId: string;
}): Promise<Order> {
  const note = normalizeNote(input.note ?? null);
  return db.transaction(async (tx) => {
    const customer = await tx.query.customers.findFirst({
      where: eq(customers.id, input.customerId),
    });
    if (!customer) throw new OrderError("CUSTOMER_NOT_FOUND");

    const orderId = ulid();
    await tx.insert(orders).values({
      id: orderId,
      customerId: customer.id,
      snapshotCustomerName: customer.name,
      totalMinor: 0,
      note,
      createdByUserId: input.createdByUserId,
    });
    const row = await tx.query.orders.findFirst({ where: eq(orders.id, orderId) });
    return row as Order;
  });
}

/**
 * Set or clear the free-text note on an open Console sale. Pass `""` to clear
 * the note; `null` is also accepted as "clear". The order must still be open.
 */
export async function updateCustomerSaleNote(input: {
  orderId: string;
  note: string | null;
}): Promise<Order> {
  const note = normalizeNote(input.note);
  return db.transaction(async (tx) => {
    const order = await loadOpenOrder(tx, input.orderId);
    await tx.update(orders).set({ note }).where(eq(orders.id, order.id));
    const row = await tx.query.orders.findFirst({ where: eq(orders.id, order.id) });
    return row as Order;
  });
}

/**
 * Add a line to an open Console sale. Decrements stock for physical lines.
 * AR is deferred: nothing is posted to `customer_ledger` while the sale is
 * open — the credit limit is checked and the debt posted once, at close.
 */
export async function addCustomerSaleItem(input: {
  orderId: string;
  item: PosOrderItemInput;
  createdByUserId: string;
}): Promise<Order> {
  return db.transaction(async (tx) => {
    const order = await loadOpenOrder(tx, input.orderId);
    const customerId = order.customerId;
    if (!customerId) throw new OrderError("CUSTOMER_NOT_FOUND");

    // One input item may explode into several lines (a bundle).
    const lines = await buildLines(tx, order.id, input.item, customerId);
    await tx.insert(orderItems).values(lines.map((l) => l.row));

    for (const line of lines) {
      if (!line.isPhysical) continue;
      await modifyStock(
        {
          variantId: line.row.variantId as string,
          type: "sale",
          qtyDelta: -(line.row.qty as number),
          refType: "order",
          refId: order.id,
          createdByUserId: input.createdByUserId,
        },
        tx,
      );
    }
    await recomputeOrderTotal(tx, order.id);

    const row = await tx.query.orders.findFirst({ where: eq(orders.id, order.id) });
    return row as Order;
  });
}

/**
 * Void a line on an open Console sale. Marks the row voided (kept for audit)
 * and returns its stock. No AR is reversed — an open sale has posted nothing to
 * `customer_ledger` yet; `recomputeOrderTotal` keeps the close-time debt right.
 * The reason is optional: deleting a line from an in-progress draft needs no
 * justification (the console surfaces this as a one-click "delete").
 */
export async function voidCustomerSaleItem(input: {
  orderItemId: string;
  reason?: string | null;
  voidedByUserId: string;
}): Promise<Order> {
  const reason = input.reason?.trim() || null;
  return db.transaction(async (tx) => {
    const item = await tx.query.orderItems.findFirst({
      where: eq(orderItems.id, input.orderItemId),
    });
    if (!item) throw new OrderError("ITEM_NOT_FOUND");
    if (item.voidedAt) throw new OrderError("ITEM_ALREADY_VOIDED");

    const order = await loadOpenOrder(tx, item.orderId);

    await tx
      .update(orderItems)
      .set({
        voidedAt: new Date(),
        voidedByUserId: input.voidedByUserId,
        voidReason: reason,
      })
      .where(eq(orderItems.id, item.id));

    // Return stock for physical lines (stock moves live even though AR doesn't).
    const product = item.productId
      ? await tx.query.products.findFirst({ where: eq(products.id, item.productId) })
      : null;
    if (product && product.kind === "physical" && item.variantId) {
      await modifyStock(
        {
          variantId: item.variantId,
          type: "sale_return",
          qtyDelta: item.qty,
          refType: "order",
          refId: order.id,
          reason: reason ? `void: ${reason}` : "void",
          createdByUserId: input.voidedByUserId,
        },
        tx,
      );
    }

    await recomputeOrderTotal(tx, order.id);

    const row = await tx.query.orders.findFirst({ where: eq(orders.id, order.id) });
    return row as Order;
  });
}

/**
 * Edit a non-voided line on an open Console sale. Each provided field is
 * applied; omitted fields are left untouched. Adjusts stock by the qty delta
 * and recomputes the attribution snapshot. AR is deferred: no customer_ledger
 * write here and no credit check — both happen once, at close.
 *
 * Bundle component lines cannot be edited — re-add the bundle instead.
 * `displayNameOverride` writes `snapshotPublicName`, which the receipt /
 * catalog already prefer over `snapshotProductName`. Pass an empty string to
 * clear it back to the default.
 */
export async function updateCustomerSaleItem(input: {
  orderItemId: string;
  qty?: number | null;
  discountMinor?: number | null;
  priceOverrideMinor?: number | null;
  displayNameOverride?: string | null;
  updatedByUserId: string;
}): Promise<Order> {
  return db.transaction(async (tx) => {
    const item = await tx.query.orderItems.findFirst({
      where: eq(orderItems.id, input.orderItemId),
    });
    if (!item) throw new OrderError("ITEM_NOT_FOUND");
    if (item.voidedAt) throw new OrderError("ITEM_ALREADY_VOIDED");
    if (item.snapshotBundleName) {
      throw new OrderError(
        "INVALID_INPUT",
        "bundle component lines are not editable; void and re-add the bundle",
      );
    }
    const order = await loadOpenOrder(tx, item.orderId);

    const oldQty = item.qty;
    const oldPrice = item.snapshotPriceMinor;
    const oldDiscount = item.discountMinor;

    let newQty = oldQty;
    if (input.qty != null) {
      if (!Number.isInteger(input.qty) || input.qty <= 0) {
        throw new OrderError("INVALID_INPUT", "qty must be a positive integer");
      }
      newQty = input.qty;
    }

    let newDiscount = oldDiscount;
    if (input.discountMinor != null) {
      if (!Number.isInteger(input.discountMinor) || input.discountMinor < 0) {
        throw new OrderError(
          "INVALID_INPUT",
          "discount must be a non-negative integer",
        );
      }
      newDiscount = input.discountMinor;
    }

    // Product kind drives the stock movement below; a price override may apply
    // to any line (bundle component lines were already rejected above).
    const product = item.productId
      ? await tx.query.products.findFirst({
          where: eq(products.id, item.productId),
        })
      : null;

    let newPrice = oldPrice;
    if (input.priceOverrideMinor != null) {
      if (
        !Number.isInteger(input.priceOverrideMinor) ||
        input.priceOverrideMinor < 0
      ) {
        throw new OrderError(
          "INVALID_INPUT",
          "price override must be a non-negative integer",
        );
      }
      newPrice = input.priceOverrideMinor;
    }

    const newTotal = newQty * newPrice - newDiscount;
    if (newTotal < 0) {
      throw new OrderError("INVALID_INPUT", "discount exceeds the line subtotal");
    }

    // Physical stock moves with qty. Positive line-qty delta → stock decreases.
    const qtyDelta = newQty - oldQty;
    if (
      product?.kind === "physical" &&
      item.variantId &&
      qtyDelta !== 0
    ) {
      await modifyStock(
        {
          variantId: item.variantId,
          type: qtyDelta > 0 ? "sale" : "sale_return",
          qtyDelta: -qtyDelta,
          refType: "order",
          refId: order.id,
          reason: `edit line ${item.id}`,
          createdByUserId: input.updatedByUserId,
        },
        tx,
      );
    }

    // Recompute attribution snapshot if the line carries one.
    let newAttribution = item.attributionAmountMinor;
    if (item.attributionAccountId && item.variantId) {
      const variant = await tx.query.productVariants.findFirst({
        where: eq(productVariants.id, item.variantId),
      });
      if (variant) {
        newAttribution = computeAttribution({
          priceMinor: newPrice,
          qty: newQty,
          discountMinor: newDiscount,
          priceMode: item.snapshotPriceMode,
          taxRateBps: item.snapshotTaxRateBps,
          mode: variant.trackingAttributionMode,
          pctBps: variant.trackingAttributionPctBps,
        });
      }
    }

    // Display name override → write snapshotPublicName, which the receipt /
    // catalog already prefer over snapshotProductName.
    const patch: Partial<typeof orderItems.$inferInsert> = {
      qty: newQty,
      discountMinor: newDiscount,
      snapshotPriceMinor: newPrice,
      attributionAmountMinor: newAttribution,
    };
    // Open-price cost is derived from the (possibly edited) price.
    if (product?.kind === "open_price") {
      patch.snapshotCostMinor = Math.round((newPrice * (product.costRatioBps ?? 0)) / 10000);
    }
    if (input.displayNameOverride !== undefined) {
      const trimmed = input.displayNameOverride?.trim() ?? "";
      patch.snapshotPublicName = trimmed === "" ? null : trimmed;
    }
    await tx.update(orderItems).set(patch).where(eq(orderItems.id, item.id));

    await recomputeOrderTotal(tx, order.id);
    const row = await tx.query.orders.findFirst({
      where: eq(orders.id, order.id),
    });
    return row as Order;
  });
}

/**
 * Record a payment against an open Console sale. Writes only the
 * `order_payments` row (the cash/drawer record). No `customer_ledger` row is
 * written while open — payments net into the single remainder posted at close,
 * so writing one here would double-count.
 */
export async function addCustomerSalePayment(input: {
  orderId: string;
  amountMinor: number;
  posSessionId?: string | null;
  createdByUserId: string;
}): Promise<Order> {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new OrderError("INVALID_INPUT", "payment amount must be a positive integer");
  }
  return db.transaction(async (tx) => {
    const order = await loadOpenOrder(tx, input.orderId);
    if (!order.customerId) throw new OrderError("CUSTOMER_NOT_FOUND");

    await tx.insert(orderPayments).values({
      id: ulid(),
      orderId: order.id,
      method: "cash",
      amountMinor: input.amountMinor,
      posSessionId: input.posSessionId ?? null,
      createdByUserId: input.createdByUserId,
    });

    const row = await tx.query.orders.findFirst({ where: eq(orders.id, order.id) });
    return row as Order;
  });
}

/**
 * Close a Console sale: assigns a `C-<date>-<seq>` display number; immutable
 * after. AR posts here, once — a single `customer_ledger` row for the unpaid
 * remainder (`sale_on_account`, or `refund_credit` if overpaid), with the
 * credit limit enforced at this point. Tracking attribution fires here only
 * when the sale is fully paid at close — an order that closes on account never
 * credits the mechanic (the design's all-or-nothing bad-debt rule). A debt
 * later settled via `recordDebtPayment` does not retro-fire attribution.
 */
export async function closeCustomerSale(input: {
  orderId: string;
  closedByUserId: string;
}): Promise<Order> {
  return db.transaction(async (tx) => {
    const order = await loadOpenOrder(tx, input.orderId);
    const customerId = order.customerId;
    const total = await recomputeOrderTotal(tx, order.id);

    const payRows = await tx
      .select({ amt: orderPayments.amountMinor })
      .from(orderPayments)
      .where(eq(orderPayments.orderId, order.id));
    const paid = payRows.reduce((sum, p) => sum + p.amt, 0);
    const remainder = total - paid;

    // AR posts once, here at close — mirroring createPosOrder. An unpaid
    // remainder is a `sale_on_account`; an overpaid sale (cash already in the
    // drawer) becomes `refund_credit` so close never fails on collected money.
    if (remainder !== 0 && customerId) {
      if (remainder > 0) {
        const customer = await tx.query.customers.findFirst({
          where: eq(customers.id, customerId),
        });
        if (
          customer?.creditLimitMinor != null &&
          customer.balanceMinor + remainder > customer.creditLimitMinor
        ) {
          throw new OrderError("CREDIT_LIMIT_EXCEEDED");
        }
      }
      await tx.insert(customerLedger).values({
        id: ulid(),
        customerId,
        type: remainder > 0 ? "sale_on_account" : "refund_credit",
        amountMinor: remainder,
        refType: "order",
        refId: order.id,
        createdByUserId: input.closedByUserId,
      });
      await syncCustomerBalance(tx, customerId);
    }

    await tx
      .update(orders)
      .set({
        closedAt: new Date(),
        closedByUserId: input.closedByUserId,
        displayNumber: await nextDisplayNumber(tx, "C"),
      })
      .where(eq(orders.id, order.id));

    if (paid >= total) {
      await postAttribution(tx, order.id, input.closedByUserId);
    }

    const row = await tx.query.orders.findFirst({ where: eq(orders.id, order.id) });
    return row as Order;
  });
}

/**
 * Cancel an open Console sale: voids every live line (returning stock) and
 * stamps `cancelled_at`. No AR is reversed — an open sale has posted nothing to
 * `customer_ledger` yet. Distinct from closing empty — intent matters for
 * reports. `reason` is required.
 */
export async function cancelCustomerSale(input: {
  orderId: string;
  reason: string;
  cancelledByUserId: string;
}): Promise<Order> {
  if (!input.reason.trim()) {
    throw new OrderError("INVALID_INPUT", "cancellation reason is required");
  }
  return db.transaction(async (tx) => {
    const order = await loadOpenOrder(tx, input.orderId);

    const items = await tx
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id));
    for (const item of items) {
      if (item.voidedAt) continue;
      await tx
        .update(orderItems)
        .set({
          voidedAt: new Date(),
          voidedByUserId: input.cancelledByUserId,
          voidReason: `cancelled: ${input.reason.trim()}`,
        })
        .where(eq(orderItems.id, item.id));

      const product = item.productId
        ? await tx.query.products.findFirst({ where: eq(products.id, item.productId) })
        : null;
      if (product && product.kind === "physical" && item.variantId) {
        await modifyStock(
          {
            variantId: item.variantId,
            type: "sale_return",
            qtyDelta: item.qty,
            refType: "order",
            refId: order.id,
            reason: `cancelled: ${input.reason.trim()}`,
            createdByUserId: input.cancelledByUserId,
          },
          tx,
        );
      }
    }

    await tx
      .update(orders)
      .set({
        cancelledAt: new Date(),
        cancelledByUserId: input.cancelledByUserId,
        cancellationReason: input.reason.trim(),
        totalMinor: 0,
      })
      .where(eq(orders.id, order.id));
    const row = await tx.query.orders.findFirst({ where: eq(orders.id, order.id) });
    return row as Order;
  });
}

/**
 * Reassign an open Console sale to a different customer (root-only). An open
 * sale has posted nothing to `customer_ledger` yet (AR commits at close), so
 * this is just a relabel — there is no balance to move and no limit to check
 * here (the credit limit is enforced when the sale is closed).
 */
export async function changeCustomerSaleCustomer(input: {
  orderId: string;
  newCustomerId: string;
  changedByUserId: string;
}): Promise<Order> {
  return db.transaction(async (tx) => {
    const order = await loadOpenOrder(tx, input.orderId);
    if (order.customerId === input.newCustomerId) {
      throw new OrderError("INVALID_INPUT", "order already belongs to that customer");
    }
    const newCustomer = await tx.query.customers.findFirst({
      where: eq(customers.id, input.newCustomerId),
    });
    if (!newCustomer) throw new OrderError("CUSTOMER_NOT_FOUND");

    await tx
      .update(orders)
      .set({
        customerId: input.newCustomerId,
        snapshotCustomerName: newCustomer.name,
      })
      .where(eq(orders.id, order.id));
    const row = await tx.query.orders.findFirst({ where: eq(orders.id, order.id) });
    return row as Order;
  });
}

// --- Returns ---
//
// A return is a new `orders` row linked to the original via `returnOfOrderId`,
// with negative-qty lines and (for cash refunds) a negative payment. The
// original sale stays immutable. Multiple partial returns may link to one
// original; `order_items.returnOfOrderItemId` bounds each line.

export interface ReturnItemInput {
  /** The original order_item being returned. */
  orderItemId: string;
  /** Units to return — positive, in the variant's smallest unit. */
  qty: number;
}

/**
 * Create a return order against a closed original. Each line snapshots the
 * original line with negative qty (discount is prorated); stock is added back
 * for physical lines. The refund is either cash (a negative `order_payments`
 * row) or store credit (a negative `refund_credit` customer_ledger row).
 */
export async function createReturn(input: {
  originalOrderId: string;
  posSessionId: string;
  items: ReturnItemInput[];
  refundMethod: "cash" | "store_credit";
  createdByUserId: string;
}): Promise<Order> {
  if (!input.items.length) throw new OrderError("NOTHING_TO_RETURN");

  return db.transaction(async (tx) => {
    const session = await tx.query.posSessions.findFirst({
      where: eq(posSessions.id, input.posSessionId),
    });
    if (!session) throw new OrderError("SESSION_NOT_FOUND");
    if (session.closedAt) throw new OrderError("SESSION_CLOSED");
    const pos = await tx.query.pointsOfSale.findFirst({
      where: eq(pointsOfSale.id, session.posId),
    });
    if (!pos) throw new OrderError("SESSION_NOT_FOUND");

    const original = await tx.query.orders.findFirst({
      where: eq(orders.id, input.originalOrderId),
    });
    if (!original) throw new OrderError("ORDER_NOT_FOUND");
    if (!original.closedAt) throw new OrderError("ORDER_NOT_CLOSED");
    if (original.cancelledAt) throw new OrderError("ORDER_CANCELLED");
    if (original.returnOfOrderId) throw new OrderError("CANNOT_RETURN_RETURN");

    const customerId = original.customerId;
    if (input.refundMethod === "store_credit" && !customerId) {
      throw new OrderError("STORE_CREDIT_NEEDS_CUSTOMER");
    }

    const returnOrderId = ulid();
    const rows: (typeof orderItems.$inferInsert)[] = [];

    for (const ret of input.items) {
      if (!Number.isInteger(ret.qty) || ret.qty <= 0) {
        throw new OrderError("INVALID_INPUT", "return qty must be a positive integer");
      }
      const orig = await tx.query.orderItems.findFirst({
        where: eq(orderItems.id, ret.orderItemId),
      });
      if (!orig || orig.orderId !== original.id) {
        throw new OrderError("ITEM_NOT_FOUND");
      }
      if (orig.voidedAt) {
        throw new OrderError("INVALID_INPUT", "cannot return a voided line");
      }

      // Units already returned on prior return orders for this exact line.
      const priorReturns = await tx
        .select()
        .from(orderItems)
        .where(eq(orderItems.returnOfOrderItemId, orig.id));
      const returned = priorReturns.reduce((sum, r) => sum - r.qty, 0);
      if (returned + ret.qty > orig.qty) {
        throw new OrderError("RETURN_QTY_EXCEEDED");
      }

      // Prorate the original discount and attribution across the units being
      // returned — a return reverses what the original line actually posted
      // (so a cashier override on the original is reversed proportionally).
      const proratedDiscount = Math.round(
        (orig.discountMinor * ret.qty) / orig.qty,
      );
      const proratedAttribution = Math.round(
        (orig.attributionAmountMinor * ret.qty) / orig.qty,
      );
      rows.push({
        id: ulid(),
        orderId: returnOrderId,
        variantId: orig.variantId,
        productId: orig.productId,
        returnOfOrderItemId: orig.id,
        qty: -ret.qty,
        discountMinor: -proratedDiscount,
        snapshotProductName: orig.snapshotProductName,
        snapshotPublicName: orig.snapshotPublicName,
        snapshotProductSku: orig.snapshotProductSku,
        snapshotProductBarcode: orig.snapshotProductBarcode,
        snapshotVariantLabel: orig.snapshotVariantLabel,
        snapshotUnit: orig.snapshotUnit,
        snapshotCategoryName: orig.snapshotCategoryName,
        snapshotPriceMinor: orig.snapshotPriceMinor,
        snapshotCostMinor: orig.snapshotCostMinor,
        snapshotTaxRateBps: orig.snapshotTaxRateBps,
        snapshotPriceMode: orig.snapshotPriceMode,
        snapshotTrackingAccountName: orig.snapshotTrackingAccountName,
        snapshotBundleName: orig.snapshotBundleName,
        attributionAccountId: orig.attributionAccountId,
        attributionAmountMinor: -proratedAttribution,
      });
    }

    const returnTotal = rows.reduce(
      (sum, r) =>
        sum + (r.qty as number) * (r.snapshotPriceMinor as number) -
        (r.discountMinor as number),
      0,
    );
    const refundAmount = -returnTotal; // positive

    const now = new Date();
    await tx.insert(orders).values({
      id: returnOrderId,
      displayNumber: await nextDisplayNumber(tx, pos.code),
      customerId,
      snapshotCustomerName: original.snapshotCustomerName,
      posSessionId: input.posSessionId,
      returnOfOrderId: original.id,
      totalMinor: returnTotal,
      closedAt: now,
      closedByUserId: input.createdByUserId,
      createdByUserId: input.createdByUserId,
    });
    await tx.insert(orderItems).values(rows);

    // Add stock back for physical lines.
    for (const r of rows) {
      if (!r.variantId) continue;
      const product = r.productId
        ? await tx.query.products.findFirst({ where: eq(products.id, r.productId) })
        : null;
      if (product && product.kind !== "physical") continue;
      await modifyStock(
        {
          variantId: r.variantId as string,
          type: "sale_return",
          qtyDelta: -(r.qty as number),
          unitCost: r.snapshotCostMinor as number,
          refType: "order",
          refId: returnOrderId,
          createdByUserId: input.createdByUserId,
        },
        tx,
      );
    }

    if (input.refundMethod === "cash") {
      await tx.insert(orderPayments).values({
        id: ulid(),
        orderId: returnOrderId,
        method: "cash",
        amountMinor: -refundAmount,
        posSessionId: input.posSessionId,
        createdByUserId: input.createdByUserId,
      });
    } else if (customerId) {
      await tx.insert(customerLedger).values({
        id: ulid(),
        customerId,
        type: "refund_credit",
        amountMinor: -refundAmount,
        refType: "order",
        refId: returnOrderId,
        posSessionId: input.posSessionId,
        createdByUserId: input.createdByUserId,
      });
      await syncCustomerBalance(tx, customerId);
    }

    // Reverse the mechanic's attribution proportionally to what was returned.
    await postAttribution(tx, returnOrderId, input.createdByUserId);

    const row = await tx.query.orders.findFirst({
      where: eq(orders.id, returnOrderId),
    });
    return row as Order;
  });
}
