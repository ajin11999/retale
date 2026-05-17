// Order service. Stage 1: `createPosOrder` — the atomic POS sale. One
// transaction writes the order, its snapshotted items, stock movements,
// payments, and a customer_ledger row for any unpaid remainder. Console
// customer sales and returns are later stages.
// See docs/design-decisions.md → "Order lifecycle" and "Payments & customer
// debt".

import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { customerLedger, customerPrices, customers } from "../db/schema/customers.ts";
import { orderItems, orderPayments, orders } from "../db/schema/orders.ts";
import { pointsOfSale, posSessions } from "../db/schema/pos.ts";
import {
  productCategories,
  productPriceTiers,
  products,
  productVariants,
} from "../db/schema/products.ts";
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
  | "WALKIN_NOT_FULLY_PAID"
  | "OVERPAID"
  | "CREDIT_LIMIT_EXCEEDED"
  | "ORDER_CLOSED"
  | "ORDER_CANCELLED"
  | "ITEM_NOT_FOUND"
  | "ITEM_ALREADY_VOIDED";

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
 * workshop scale.
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

/** Built order_items insert row plus the computed line total. */
interface BuiltLine {
  row: typeof orderItems.$inferInsert;
  lineTotal: number;
  isPhysical: boolean;
}

async function buildLine(
  tx: Tx,
  orderId: string,
  item: PosOrderItemInput,
  customerId: string | null,
): Promise<BuiltLine> {
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

  const isService = product.kind === "service";
  if (item.priceOverrideMinor != null && !isService) {
    throw new OrderError(
      "PRICE_OVERRIDE_NOT_ALLOWED",
      "price overrides are allowed only on service products",
    );
  }

  let price: number;
  if (isService && item.priceOverrideMinor != null) {
    if (!Number.isInteger(item.priceOverrideMinor) || item.priceOverrideMinor < 0) {
      throw new OrderError("INVALID_INPUT", "price override must be a non-negative integer");
    }
    price = item.priceOverrideMinor;
  } else {
    price = await resolvePrice(tx, variant, customerId, item.qty);
  }

  const lineTotal = item.qty * price - discount;
  if (lineTotal < 0) {
    throw new OrderError("INVALID_INPUT", "discount exceeds the line subtotal");
  }

  const category = product.categoryId
    ? await tx.query.productCategories.findFirst({
        where: eq(productCategories.id, product.categoryId),
      })
    : null;

  return {
    isPhysical: !isService,
    lineTotal,
    row: {
      id: ulid(),
      orderId,
      variantId: variant.id,
      productId: product.id,
      qty: item.qty,
      discountMinor: discount,
      snapshotProductName: product.name,
      snapshotProductSku: variant.sku,
      snapshotProductBarcode: variant.barcode,
      snapshotVariantLabel: variant.label,
      snapshotUnit: variant.unit,
      snapshotCategoryName: category?.name ?? null,
      snapshotPriceMinor: price,
      snapshotCostMinor: isService ? 0 : variant.costMinor,
      snapshotTaxRateBps: product.taxRateBps,
      snapshotPriceMode: product.priceMode,
      // Tracking-account attribution is filled once that domain is built.
      snapshotTrackingAccountName: null,
      attributionAccountId: null,
      attributionAmountMinor: 0,
    },
  };
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
      lines.push(await buildLine(tx, orderId, item, customerId));
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

/** Open an empty Console customer sale for a customer. */
export async function createCustomerSale(input: {
  customerId: string;
  createdByUserId: string;
}): Promise<Order> {
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
      createdByUserId: input.createdByUserId,
    });
    const row = await tx.query.orders.findFirst({ where: eq(orders.id, orderId) });
    return row as Order;
  });
}

/**
 * Add a line to an open Console sale. Decrements stock (physical lines) and
 * posts a `sale_on_account` ledger row for the line total, rejecting it if
 * that would breach the customer's credit limit.
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
    const customer = await tx.query.customers.findFirst({
      where: eq(customers.id, customerId),
    });
    if (!customer) throw new OrderError("CUSTOMER_NOT_FOUND");

    const line = await buildLine(tx, order.id, input.item, customerId);

    if (
      customer.creditLimitMinor != null &&
      customer.balanceMinor + line.lineTotal > customer.creditLimitMinor
    ) {
      throw new OrderError("CREDIT_LIMIT_EXCEEDED");
    }

    await tx.insert(orderItems).values(line.row);

    if (line.isPhysical) {
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

    await tx.insert(customerLedger).values({
      id: ulid(),
      customerId,
      type: "sale_on_account",
      amountMinor: line.lineTotal,
      refType: "order_item",
      refId: line.row.id as string,
      createdByUserId: input.createdByUserId,
    });
    await syncCustomerBalance(tx, customerId);
    await recomputeOrderTotal(tx, order.id);

    const row = await tx.query.orders.findFirst({ where: eq(orders.id, order.id) });
    return row as Order;
  });
}

/**
 * Void a line on an open Console sale. Marks the row voided (kept for audit),
 * returns its stock, and posts a reversing `sale_on_account` ledger row.
 */
export async function voidCustomerSaleItem(input: {
  orderItemId: string;
  reason: string;
  voidedByUserId: string;
}): Promise<Order> {
  if (!input.reason.trim()) {
    throw new OrderError("INVALID_INPUT", "void reason is required");
  }
  return db.transaction(async (tx) => {
    const item = await tx.query.orderItems.findFirst({
      where: eq(orderItems.id, input.orderItemId),
    });
    if (!item) throw new OrderError("ITEM_NOT_FOUND");
    if (item.voidedAt) throw new OrderError("ITEM_ALREADY_VOIDED");

    const order = await loadOpenOrder(tx, item.orderId);
    const customerId = order.customerId;
    if (!customerId) throw new OrderError("CUSTOMER_NOT_FOUND");

    await tx
      .update(orderItems)
      .set({
        voidedAt: new Date(),
        voidedByUserId: input.voidedByUserId,
        voidReason: input.reason.trim(),
      })
      .where(eq(orderItems.id, item.id));

    // Return stock for physical lines (services never moved the ledger).
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
          reason: `void: ${input.reason.trim()}`,
          createdByUserId: input.voidedByUserId,
        },
        tx,
      );
    }

    await tx.insert(customerLedger).values({
      id: ulid(),
      customerId,
      type: "sale_on_account",
      amountMinor: -lineTotalOf(item),
      refType: "order_item",
      refId: item.id,
      note: `void: ${input.reason.trim()}`,
      createdByUserId: input.voidedByUserId,
    });
    await syncCustomerBalance(tx, customerId);
    await recomputeOrderTotal(tx, order.id);

    const row = await tx.query.orders.findFirst({ where: eq(orders.id, order.id) });
    return row as Order;
  });
}

/**
 * Record a payment against an open Console sale. Writes the `order_payments`
 * row and a `payment` customer_ledger row that reduces the balance.
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
    const customerId = order.customerId;
    if (!customerId) throw new OrderError("CUSTOMER_NOT_FOUND");

    const paymentId = ulid();
    await tx.insert(orderPayments).values({
      id: paymentId,
      orderId: order.id,
      method: "cash",
      amountMinor: input.amountMinor,
      posSessionId: input.posSessionId ?? null,
      createdByUserId: input.createdByUserId,
    });
    await tx.insert(customerLedger).values({
      id: ulid(),
      customerId,
      type: "payment",
      amountMinor: -input.amountMinor,
      refType: "payment",
      refId: paymentId,
      posSessionId: input.posSessionId ?? null,
      createdByUserId: input.createdByUserId,
    });
    await syncCustomerBalance(tx, customerId);

    const row = await tx.query.orders.findFirst({ where: eq(orders.id, order.id) });
    return row as Order;
  });
}

/** Close a Console sale: assigns a `C-<date>-<seq>` display number; immutable after. */
export async function closeCustomerSale(input: {
  orderId: string;
  closedByUserId: string;
}): Promise<Order> {
  return db.transaction(async (tx) => {
    const order = await loadOpenOrder(tx, input.orderId);
    await recomputeOrderTotal(tx, order.id);
    await tx
      .update(orders)
      .set({
        closedAt: new Date(),
        closedByUserId: input.closedByUserId,
        displayNumber: await nextDisplayNumber(tx, "C"),
      })
      .where(eq(orders.id, order.id));
    const row = await tx.query.orders.findFirst({ where: eq(orders.id, order.id) });
    return row as Order;
  });
}

/**
 * Cancel an open Console sale: voids every live line (returning stock and
 * reversing ledger rows) and stamps `cancelled_at`. Distinct from closing
 * empty — intent matters for reports. `reason` is required.
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
    const customerId = order.customerId;

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
      if (customerId) {
        await tx.insert(customerLedger).values({
          id: ulid(),
          customerId,
          type: "sale_on_account",
          amountMinor: -lineTotalOf(item),
          refType: "order_item",
          refId: item.id,
          note: `cancelled: ${input.reason.trim()}`,
          createdByUserId: input.cancelledByUserId,
        });
      }
    }
    if (customerId) await syncCustomerBalance(tx, customerId);

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
 * Reassign an open Console sale to a different customer (root-only). Moves the
 * sale's net ledger contribution off the old customer and onto the new one as
 * a paired `adjustment`, then re-checks the new customer's credit limit.
 */
export async function changeCustomerSaleCustomer(input: {
  orderId: string;
  newCustomerId: string;
  changedByUserId: string;
}): Promise<Order> {
  return db.transaction(async (tx) => {
    const order = await loadOpenOrder(tx, input.orderId);
    const oldCustomerId = order.customerId;
    if (oldCustomerId === input.newCustomerId) {
      throw new OrderError("INVALID_INPUT", "order already belongs to that customer");
    }
    const newCustomer = await tx.query.customers.findFirst({
      where: eq(customers.id, input.newCustomerId),
    });
    if (!newCustomer) throw new OrderError("CUSTOMER_NOT_FOUND");

    // Net ledger contribution of this order = its item rows minus payments.
    const itemRows = await tx
      .select({ id: orderItems.id })
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id));
    const payRows = await tx
      .select({ id: orderPayments.id })
      .from(orderPayments)
      .where(eq(orderPayments.orderId, order.id));
    const refIds = [...itemRows, ...payRows].map((r) => r.id);
    const ledgerRows = refIds.length
      ? await tx
          .select()
          .from(customerLedger)
          .where(inArray(customerLedger.refId, refIds))
      : [];
    const net = ledgerRows.reduce((sum, r) => sum + r.amountMinor, 0);

    if (
      net > 0 &&
      newCustomer.creditLimitMinor != null &&
      newCustomer.balanceMinor + net > newCustomer.creditLimitMinor
    ) {
      throw new OrderError("CREDIT_LIMIT_EXCEEDED");
    }

    if (net !== 0 && oldCustomerId) {
      await tx.insert(customerLedger).values({
        id: ulid(),
        customerId: oldCustomerId,
        type: "adjustment",
        amountMinor: -net,
        note: `open sale ${order.id} reassigned to customer ${input.newCustomerId}`,
        createdByUserId: input.changedByUserId,
      });
      await syncCustomerBalance(tx, oldCustomerId);
    }
    if (net !== 0) {
      await tx.insert(customerLedger).values({
        id: ulid(),
        customerId: input.newCustomerId,
        type: "adjustment",
        amountMinor: net,
        note: `open sale ${order.id} reassigned from customer ${oldCustomerId ?? "none"}`,
        createdByUserId: input.changedByUserId,
      });
      await syncCustomerBalance(tx, input.newCustomerId);
    }

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
