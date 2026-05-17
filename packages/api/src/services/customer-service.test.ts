// Integration tests for the customers service — CRUD, the balance-guarded
// hard delete, the AR ledger writers, and per-customer price overrides. These
// run against the local Docker MariaDB (DATABASE_URL) and WIPE the customer /
// product tables between tests, so point them only at a dev database.
//
//   bun test src/services/customer-service.test.ts

import "../lib/load-env.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { users } from "../db/schema/auth.ts";
import { customerLedger } from "../db/schema/customers.ts";
import { products, productVariants } from "../db/schema/products.ts";
import { db } from "../lib/db.ts";
import {
  adjustCustomerBalance,
  createCustomer,
  CustomerError,
  type CustomerErrorCode,
  hardDeleteCustomer,
  listCustomerLedger,
  listCustomerPrices,
  recordDebtPayment,
  removeCustomerPrice,
  setCustomerArchived,
  setCustomerCreditLimit,
  setCustomerPrice,
  updateCustomer,
} from "./customer-service.ts";

let userId: string;

/** Truncate every domain table touched by these tests. Users are kept. */
async function wipe(): Promise<void> {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of [
    "customer_prices",
    "customer_ledger",
    "customers",
    "product_variants",
    "products",
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
    name: "Customer Test",
  });
});

afterAll(async () => {
  await wipe();
  await db.delete(users).where(eq(users.id, userId));
  // The shared pool is closed once globally — see src/test-setup.ts.
});

beforeEach(wipe);

/** Create a product + one variant; returns the variant id. */
async function seedVariant(): Promise<string> {
  const productId = ulid();
  const variantId = ulid();
  await db.insert(products).values({
    id: productId,
    name: "Widget",
    priceMode: "tax_exclusive",
  });
  await db.insert(productVariants).values({
    id: variantId,
    productId,
    sku: `SKU-${variantId}`,
    priceMinor: 1000,
  });
  return variantId;
}

/** Assert a CustomerError with the expected code is thrown. */
async function expectError(
  code: CustomerErrorCode,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CustomerError);
    expect((e as CustomerError).code).toBe(code);
    return;
  }
  throw new Error(`expected CustomerError ${code}, nothing thrown`);
}

describe("createCustomer / updateCustomer", () => {
  test("creates a customer with a zero balance", async () => {
    const c = await createCustomer({ name: "Pak Budi", createdByUserId: userId });
    expect(c.name).toBe("Pak Budi");
    expect(c.balanceMinor).toBe(0);
    expect(c.creditLimitMinor).toBeNull();
  });

  test("rejects a blank name", async () => {
    await expectError("INVALID_INPUT", () =>
      createCustomer({ name: "  ", createdByUserId: userId }),
    );
  });

  test("updates contact fields", async () => {
    const c = await createCustomer({ name: "Pak Budi", createdByUserId: userId });
    const updated = await updateCustomer(c.id, { phone: "0812", notes: "VIP" });
    expect(updated.phone).toBe("0812");
    expect(updated.notes).toBe("VIP");
  });
});

describe("ledger writers", () => {
  test("recordDebtPayment writes a negative row and syncs the balance", async () => {
    const c = await createCustomer({ name: "Debtor", createdByUserId: userId });
    await adjustCustomerBalance({
      customerId: c.id,
      amountMinor: 50000,
      note: "opening debt",
      createdByUserId: userId,
    });
    const afterPay = await recordDebtPayment({
      customerId: c.id,
      amountMinor: 20000,
      createdByUserId: userId,
    });
    expect(afterPay.balanceMinor).toBe(30000);

    const ledger = await listCustomerLedger(c.id);
    expect(ledger).toHaveLength(2);
    const sum = ledger.reduce((acc, r) => acc + r.amountMinor, 0);
    expect(sum).toBe(30000);
  });

  test("recordDebtPayment rejects a non-positive amount", async () => {
    const c = await createCustomer({ name: "Debtor", createdByUserId: userId });
    await expectError("INVALID_INPUT", () =>
      recordDebtPayment({ customerId: c.id, amountMinor: 0, createdByUserId: userId }),
    );
  });

  test("adjustCustomerBalance requires a note", async () => {
    const c = await createCustomer({ name: "Debtor", createdByUserId: userId });
    await expectError("INVALID_INPUT", () =>
      adjustCustomerBalance({
        customerId: c.id,
        amountMinor: 1000,
        note: "  ",
        createdByUserId: userId,
      }),
    );
  });
});

describe("setCustomerCreditLimit", () => {
  test("sets and clears the limit", async () => {
    const c = await createCustomer({ name: "Pak Budi", createdByUserId: userId });
    expect((await setCustomerCreditLimit(c.id, 100000)).creditLimitMinor).toBe(100000);
    expect((await setCustomerCreditLimit(c.id, null)).creditLimitMinor).toBeNull();
  });

  test("rejects a negative limit", async () => {
    const c = await createCustomer({ name: "Pak Budi", createdByUserId: userId });
    await expectError("INVALID_INPUT", () => setCustomerCreditLimit(c.id, -1));
  });
});

describe("hardDeleteCustomer", () => {
  test("deletes a zero-balance customer", async () => {
    const c = await createCustomer({ name: "Pak Budi", createdByUserId: userId });
    await hardDeleteCustomer(c.id);
    await expectError("CUSTOMER_NOT_FOUND", () => listCustomerLedger(c.id));
  });

  test("refuses a customer carrying a balance", async () => {
    const c = await createCustomer({ name: "Debtor", createdByUserId: userId });
    await adjustCustomerBalance({
      customerId: c.id,
      amountMinor: 5000,
      note: "debt",
      createdByUserId: userId,
    });
    await expectError("HAS_BALANCE", () => hardDeleteCustomer(c.id));
  });

  test("cascade-deletes the ledger", async () => {
    const c = await createCustomer({ name: "Debtor", createdByUserId: userId });
    await adjustCustomerBalance({
      customerId: c.id,
      amountMinor: 5000,
      note: "debt",
      createdByUserId: userId,
    });
    // Settle to zero so the delete is allowed, then delete.
    await recordDebtPayment({ customerId: c.id, amountMinor: 5000, createdByUserId: userId });
    await hardDeleteCustomer(c.id);
    const orphans = await db
      .select()
      .from(customerLedger)
      .where(eq(customerLedger.customerId, c.id));
    expect(orphans).toHaveLength(0);
  });
});

describe("customer prices", () => {
  test("setCustomerPrice upserts; second call updates in place", async () => {
    const c = await createCustomer({ name: "Pak Budi", createdByUserId: userId });
    const variantId = await seedVariant();

    const first = await setCustomerPrice({ customerId: c.id, variantId, priceMinor: 800 });
    expect(first.priceMinor).toBe(800);

    const second = await setCustomerPrice({ customerId: c.id, variantId, priceMinor: 750 });
    expect(second.id).toBe(first.id);
    expect(second.priceMinor).toBe(750);

    expect(await listCustomerPrices(c.id)).toHaveLength(1);
  });

  test("rejects an unknown variant", async () => {
    const c = await createCustomer({ name: "Pak Budi", createdByUserId: userId });
    await expectError("VARIANT_NOT_FOUND", () =>
      setCustomerPrice({ customerId: c.id, variantId: ulid(), priceMinor: 800 }),
    );
  });

  test("removeCustomerPrice deletes the override", async () => {
    const c = await createCustomer({ name: "Pak Budi", createdByUserId: userId });
    const variantId = await seedVariant();
    await setCustomerPrice({ customerId: c.id, variantId, priceMinor: 800 });
    await removeCustomerPrice(c.id, variantId);
    expect(await listCustomerPrices(c.id)).toHaveLength(0);
  });

  test("removeCustomerPrice on a missing override throws", async () => {
    const c = await createCustomer({ name: "Pak Budi", createdByUserId: userId });
    const variantId = await seedVariant();
    await expectError("PRICE_NOT_FOUND", () => removeCustomerPrice(c.id, variantId));
  });
});

describe("archive", () => {
  test("archive then unarchive toggles archivedAt", async () => {
    const c = await createCustomer({ name: "Pak Budi", createdByUserId: userId });
    expect((await setCustomerArchived(c.id, true)).archivedAt).not.toBeNull();
    expect((await setCustomerArchived(c.id, false)).archivedAt).toBeNull();
  });
});
