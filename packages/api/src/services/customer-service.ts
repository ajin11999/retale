// Customers service: CRUD, archive, a balance-guarded hard delete, the
// root-only credit-limit setter, the two AR ledger writers
// (`recordDebtPayment`, `adjustCustomerBalance`), and per-customer variant
// price overrides. Every ledger insert recomputes `customers.balanceMinor` in
// the same transaction so the cached total never drifts.
// See docs/design-decisions.md → "Customers" and "Payments & customer debt".

import { and, desc, eq, isNull, like, or, sql } from "drizzle-orm";
import { ulid } from "ulid";
import {
  customerLedger,
  customerPrices,
  customers,
} from "../db/schema/customers.ts";
import { productVariants } from "../db/schema/products.ts";
import { db } from "../lib/db.ts";
import { isMoney } from "../lib/money.ts";

export type CustomerErrorCode =
  | "CUSTOMER_NOT_FOUND"
  | "VARIANT_NOT_FOUND"
  | "PRICE_NOT_FOUND"
  | "INVALID_INPUT"
  | "HAS_BALANCE";

export class CustomerError extends Error {
  constructor(
    public code: CustomerErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "CustomerError";
  }
}

type Customer = typeof customers.$inferSelect;
type LedgerEntry = typeof customerLedger.$inferSelect;
type CustomerPrice = typeof customerPrices.$inferSelect;

/** A drizzle transaction handle; structurally a subset of `db`. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function listCustomers(includeArchived = false): Promise<Customer[]> {
  return db
    .select()
    .from(customers)
    .where(includeArchived ? undefined : isNull(customers.archivedAt));
}

/**
 * Lightweight name/phone search for the POS register, used to attach a customer
 * to a sale. Archived customers are excluded; an empty `search` lists the first
 * `limit` active customers by name. `limit` is clamped to 1..50.
 */
export function searchCustomers(
  search: string | null | undefined,
  limit = 20,
): Promise<Customer[]> {
  const cap = Math.min(Math.max(limit, 1), 50);
  const trimmed = search?.trim();
  const where = trimmed
    ? and(
        isNull(customers.archivedAt),
        or(
          like(customers.name, `%${trimmed}%`),
          like(customers.phone, `%${trimmed}%`),
        ),
      )
    : isNull(customers.archivedAt);
  return db
    .select()
    .from(customers)
    .where(where)
    .orderBy(customers.name)
    .limit(cap);
}

async function loadCustomer(id: string): Promise<Customer> {
  const row = await db.query.customers.findFirst({
    where: eq(customers.id, id),
  });
  if (!row) throw new CustomerError("CUSTOMER_NOT_FOUND");
  return row;
}

export { loadCustomer as getCustomer };

export async function createCustomer(input: {
  name: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  notes?: string | null;
  createdByUserId: string;
}): Promise<Customer> {
  if (!input.name.trim()) {
    throw new CustomerError("INVALID_INPUT", "name is required");
  }

  const id = ulid();
  await db.insert(customers).values({
    id,
    name: input.name.trim(),
    phone: input.phone ?? null,
    email: input.email ?? null,
    address: input.address ?? null,
    notes: input.notes ?? null,
    createdByUserId: input.createdByUserId,
  });
  return loadCustomer(id);
}

export async function updateCustomer(
  id: string,
  patch: {
    name?: string;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
    notes?: string | null;
  },
): Promise<Customer> {
  await loadCustomer(id);
  if (patch.name !== undefined && !patch.name.trim()) {
    throw new CustomerError("INVALID_INPUT", "name cannot be blank");
  }

  await db
    .update(customers)
    .set({
      ...(patch.name !== undefined && { name: patch.name.trim() }),
      ...(patch.phone !== undefined && { phone: patch.phone }),
      ...(patch.email !== undefined && { email: patch.email }),
      ...(patch.address !== undefined && { address: patch.address }),
      ...(patch.notes !== undefined && { notes: patch.notes }),
    })
    .where(eq(customers.id, id));
  return loadCustomer(id);
}

export async function setCustomerArchived(
  id: string,
  archived: boolean,
): Promise<Customer> {
  await loadCustomer(id);
  await db
    .update(customers)
    .set({ archivedAt: archived ? new Date() : null })
    .where(eq(customers.id, id));
  return loadCustomer(id);
}

/**
 * Root-only credit-limit setter. `creditLimitMinor` of null clears the limit;
 * a value must be a non-negative integer.
 */
export async function setCustomerCreditLimit(
  id: string,
  creditLimitMinor: number | null,
): Promise<Customer> {
  await loadCustomer(id);
  if (
    creditLimitMinor !== null &&
    (!isMoney(creditLimitMinor) || creditLimitMinor < 0)
  ) {
    throw new CustomerError(
      "INVALID_INPUT",
      "credit limit must be a non-negative amount or null",
    );
  }
  await db
    .update(customers)
    .set({ creditLimitMinor })
    .where(eq(customers.id, id));
  return loadCustomer(id);
}

/**
 * Hard delete. Refused while the customer carries a non-zero AR balance. The
 * "no non-cancelled orders" half of the rule (design-decisions.md) is enforced
 * once the orders domain exists; `customer_ledger` and `customer_prices`
 * cascade-delete.
 */
export async function hardDeleteCustomer(id: string): Promise<void> {
  const customer = await loadCustomer(id);
  if (customer.balanceMinor !== 0) throw new CustomerError("HAS_BALANCE");
  await db.delete(customers).where(eq(customers.id, id));
}

/** Per-customer ledger SUM → write it back to the cached `balanceMinor`. */
async function syncBalance(tx: Tx, customerId: string): Promise<void> {
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

/**
 * Record a cash payment against an existing customer debt — no order involved.
 * `amountMinor` is the positive sum received; it is stored as a negative
 * ledger row (it reduces what they owe). `posSessionId` is expected when the
 * cash enters a POS drawer — not yet enforced (no POS sessions domain).
 * Returns the refreshed customer.
 */
export async function recordDebtPayment(input: {
  customerId: string;
  amountMinor: number;
  posSessionId?: string | null;
  note?: string | null;
  createdByUserId: string;
}): Promise<Customer> {
  if (!isMoney(input.amountMinor) || input.amountMinor <= 0) {
    throw new CustomerError(
      "INVALID_INPUT",
      "payment amount must be a positive amount",
    );
  }
  return db.transaction(async (tx) => {
    const customer = await tx.query.customers.findFirst({
      where: eq(customers.id, input.customerId),
    });
    if (!customer) throw new CustomerError("CUSTOMER_NOT_FOUND");

    await tx.insert(customerLedger).values({
      id: ulid(),
      customerId: input.customerId,
      type: "payment",
      amountMinor: -input.amountMinor,
      refType: "payment",
      note: input.note ?? null,
      posSessionId: input.posSessionId ?? null,
      createdByUserId: input.createdByUserId,
    });
    await syncBalance(tx, input.customerId);

    const row = await tx.query.customers.findFirst({
      where: eq(customers.id, input.customerId),
    });
    return row as Customer;
  });
}

/**
 * Root-only manual balance correction (bad-debt write-off, dispute
 * settlement). A signed `amountMinor` — positive grows what they owe, negative
 * shrinks it — and a `note` are both required.
 */
export async function adjustCustomerBalance(input: {
  customerId: string;
  amountMinor: number;
  note: string;
  createdByUserId: string;
}): Promise<Customer> {
  if (!isMoney(input.amountMinor) || input.amountMinor === 0) {
    throw new CustomerError(
      "INVALID_INPUT",
      "adjustment amount must be a non-zero integer",
    );
  }
  if (!input.note.trim()) {
    throw new CustomerError("INVALID_INPUT", "adjustment note is required");
  }
  return db.transaction(async (tx) => {
    const customer = await tx.query.customers.findFirst({
      where: eq(customers.id, input.customerId),
    });
    if (!customer) throw new CustomerError("CUSTOMER_NOT_FOUND");

    await tx.insert(customerLedger).values({
      id: ulid(),
      customerId: input.customerId,
      type: "adjustment",
      amountMinor: input.amountMinor,
      refType: "adjustment",
      note: input.note.trim(),
      createdByUserId: input.createdByUserId,
    });
    await syncBalance(tx, input.customerId);

    const row = await tx.query.customers.findFirst({
      where: eq(customers.id, input.customerId),
    });
    return row as Customer;
  });
}

/** Recent ledger entries for a customer, newest first. */
export async function listCustomerLedger(
  customerId: string,
  limit = 100,
): Promise<LedgerEntry[]> {
  await loadCustomer(customerId);
  return db
    .select()
    .from(customerLedger)
    .where(eq(customerLedger.customerId, customerId))
    .orderBy(desc(customerLedger.createdAt))
    .limit(Math.min(Math.max(limit, 1), 500));
}

// --- Per-customer variant price overrides ---

/** All price overrides for a customer. */
export async function listCustomerPrices(
  customerId: string,
): Promise<CustomerPrice[]> {
  await loadCustomer(customerId);
  return db
    .select()
    .from(customerPrices)
    .where(eq(customerPrices.customerId, customerId));
}

/**
 * Upsert a price override for `(customerId, variantId)`. `priceMinor` must be
 * a non-negative integer. Returns the resulting row.
 */
export async function setCustomerPrice(input: {
  customerId: string;
  variantId: string;
  priceMinor: number;
}): Promise<CustomerPrice> {
  await loadCustomer(input.customerId);
  if (!isMoney(input.priceMinor) || input.priceMinor < 0) {
    throw new CustomerError(
      "INVALID_INPUT",
      "price must be a non-negative integer",
    );
  }
  const variant = await db.query.productVariants.findFirst({
    where: eq(productVariants.id, input.variantId),
  });
  if (!variant) throw new CustomerError("VARIANT_NOT_FOUND");

  const existing = await db.query.customerPrices.findFirst({
    where: and(
      eq(customerPrices.customerId, input.customerId),
      eq(customerPrices.variantId, input.variantId),
    ),
  });
  if (existing) {
    await db
      .update(customerPrices)
      .set({ priceMinor: input.priceMinor })
      .where(eq(customerPrices.id, existing.id));
    return { ...existing, priceMinor: input.priceMinor };
  }
  const id = ulid();
  await db.insert(customerPrices).values({
    id,
    customerId: input.customerId,
    variantId: input.variantId,
    priceMinor: input.priceMinor,
  });
  const row = await db.query.customerPrices.findFirst({
    where: eq(customerPrices.id, id),
  });
  return row as CustomerPrice;
}

/** Remove a price override for `(customerId, variantId)`. */
export async function removeCustomerPrice(
  customerId: string,
  variantId: string,
): Promise<void> {
  const existing = await db.query.customerPrices.findFirst({
    where: and(
      eq(customerPrices.customerId, customerId),
      eq(customerPrices.variantId, variantId),
    ),
  });
  if (!existing) throw new CustomerError("PRICE_NOT_FOUND");
  await db.delete(customerPrices).where(eq(customerPrices.id, existing.id));
}
