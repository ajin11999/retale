// Integration tests for product-alert-service — the margin-threshold scan and
// acknowledgement. Runs against the local Docker MariaDB (DATABASE_URL) and
// WIPEs the product / alert tables between tests, so point it only at a dev
// database.
//
//   bun test src/services/product-alert-service.test.ts

import "../lib/load-env.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { users } from "../db/schema/auth.ts";
import { productAlerts } from "../db/schema/product-alerts.ts";
import { productCategories, products, productVariants } from "../db/schema/products.ts";
import { db } from "../lib/db.ts";
import {
  acknowledgeProductAlert,
  AUTO_RESOLVE_NOTE,
  classifyVariant,
  evaluateProductAlerts,
  listProductAlerts,
  ProductAlertError,
  type ProductAlertErrorCode,
  purgeAcknowledgedProductAlerts,
  scanProductAlerts,
} from "./product-alert-service.ts";

let userId: string;

async function wipe(): Promise<void> {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of [
    "product_alerts",
    "product_variants",
    "products",
    "product_categories",
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
    name: "Product Alert Test",
  });
});

afterAll(async () => {
  await wipe();
  await db.delete(users).where(eq(users.id, userId));
});

beforeEach(wipe);

async function seedCategory(minMarginBps: number): Promise<string> {
  const id = ulid();
  await db.insert(productCategories).values({ id, name: "Cat", minMarginBps });
  return id;
}

/** Seed a product + one variant with chosen price/cost. Returns the product id. */
async function seedProduct(opts: {
  minMarginBps?: number | null;
  categoryId?: string | null;
  archived?: boolean;
  priceMinor: number;
  costMinor: number;
}): Promise<string> {
  const productId = ulid();
  const variantId = ulid();
  await db.insert(products).values({
    id: productId,
    name: "Widget",
    priceMode: "tax_exclusive",
    minMarginBps: opts.minMarginBps ?? null,
    categoryId: opts.categoryId ?? null,
    archivedAt: opts.archived ? new Date() : null,
  });
  await db.insert(productVariants).values({
    id: variantId,
    productId,
    sku: `SKU-${variantId}`,
    priceMinor: opts.priceMinor,
    costMinor: opts.costMinor,
  });
  return productId;
}

async function expectError(
  p: Promise<unknown>,
  code: ProductAlertErrorCode,
): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProductAlertError);
  expect((err as ProductAlertError).code).toBe(code);
}

describe("classifyVariant", () => {
  test("classifies margin breaches and anomalies", () => {
    // price 1000, cost 900 → 10% margin; threshold 20% → low_margin.
    expect(classifyVariant(1000, 900, 2000)?.type).toBe("low_margin");
    // healthy 50% margin above threshold.
    expect(classifyVariant(1000, 500, 2000)).toBeNull();
    // no threshold → low_margin is never raised.
    expect(classifyVariant(1000, 900, null)).toBeNull();
    // anomalies fire regardless of threshold.
    expect(classifyVariant(500, 900, null)?.type).toBe("negative_margin");
    expect(classifyVariant(-100, 500, 2000)?.type).toBe("negative_price");
    expect(classifyVariant(1000, -50, 2000)?.type).toBe("data_anomaly");
    // unpriced (price 0) but with a real cost → sells at a loss, no % margin.
    expect(classifyVariant(0, 500, 2000)?.type).toBe("negative_margin");
    expect(classifyVariant(0, 500, 2000)?.marginBps).toBeNull();
    // cost not yet established → nothing to measure against, skipped.
    expect(classifyVariant(1000, 0, 2000)).toBeNull();
    expect(classifyVariant(0, 0, 2000)).toBeNull();
  });
});

describe("scanProductAlerts", () => {
  test("raises low_margin for a product below its threshold", async () => {
    await seedProduct({ minMarginBps: 2000, priceMinor: 1000, costMinor: 900 });
    const raised = await scanProductAlerts();
    expect(raised).toHaveLength(1);
    expect(raised[0]?.type).toBe("low_margin");
  });

  test("inherits the margin threshold from the category", async () => {
    const categoryId = await seedCategory(2000);
    await seedProduct({ categoryId, priceMinor: 1000, costMinor: 950 });
    const raised = await scanProductAlerts();
    expect(raised.map((a) => a.type)).toEqual(["low_margin"]);
  });

  test("raises anomalies even with no threshold set", async () => {
    await seedProduct({ priceMinor: 500, costMinor: 900 }); // sells at a loss
    const raised = await scanProductAlerts();
    expect(raised.map((a) => a.type)).toEqual(["negative_margin"]);
  });

  test("does not flag a healthy product", async () => {
    await seedProduct({ minMarginBps: 2000, priceMinor: 1000, costMinor: 500 });
    expect(await scanProductAlerts()).toHaveLength(0);
  });

  test("skips archived products", async () => {
    await seedProduct({
      minMarginBps: 2000,
      priceMinor: 1000,
      costMinor: 950,
      archived: true,
    });
    expect(await scanProductAlerts()).toHaveLength(0);
  });

  test("is idempotent — a second scan raises no duplicate", async () => {
    await seedProduct({ minMarginBps: 2000, priceMinor: 1000, costMinor: 900 });
    expect(await scanProductAlerts()).toHaveLength(1);
    expect(await scanProductAlerts()).toHaveLength(0);
    expect(await listProductAlerts({ acknowledged: false })).toHaveLength(1);
  });

  test("auto-resolves an open alert once its condition recovers", async () => {
    const productId = await seedProduct({
      minMarginBps: 2000,
      priceMinor: 1000,
      costMinor: 900,
    });
    expect(await scanProductAlerts()).toHaveLength(1);

    // Reprice to a healthy margin, then rescan.
    await db
      .update(productVariants)
      .set({ priceMinor: 2000 })
      .where(eq(productVariants.productId, productId));
    expect(await scanProductAlerts()).toHaveLength(0);

    // The open alert is gone; it now lives in history with the system note.
    expect(await listProductAlerts({ acknowledged: false })).toHaveLength(0);
    const [resolved] = await listProductAlerts({ acknowledged: true });
    expect(resolved?.acknowledgedAt).not.toBeNull();
    expect(resolved?.acknowledgedByUserId).toBeNull();
    expect(resolved?.resolutionNote).toBe(AUTO_RESOLVE_NOTE);
  });

  test("leaves alerts for archived products untouched", async () => {
    // Raise an alert, then archive the product. A later scan can't reassess it,
    // so it must not auto-resolve the still-open alert.
    const productId = await seedProduct({
      minMarginBps: 2000,
      priceMinor: 1000,
      costMinor: 900,
    });
    expect(await scanProductAlerts()).toHaveLength(1);
    await db
      .update(products)
      .set({ archivedAt: new Date() })
      .where(eq(products.id, productId));

    expect(await scanProductAlerts()).toHaveLength(0);
    expect(await listProductAlerts({ acknowledged: false })).toHaveLength(1);
  });
});

describe("evaluateProductAlerts", () => {
  test("evaluates a single product", async () => {
    const productId = await seedProduct({
      minMarginBps: 2000,
      priceMinor: 1000,
      costMinor: 900,
    });
    const raised = await evaluateProductAlerts(productId);
    expect(raised).toHaveLength(1);
    expect(raised[0]?.productId).toBe(productId);
  });

  test("rejects an unknown product", async () => {
    await expectError(evaluateProductAlerts(ulid()), "PRODUCT_NOT_FOUND");
  });

  test("auto-resolves the product's open alert when it recovers", async () => {
    const productId = await seedProduct({
      minMarginBps: 2000,
      priceMinor: 1000,
      costMinor: 900,
    });
    expect(await evaluateProductAlerts(productId)).toHaveLength(1);

    await db
      .update(productVariants)
      .set({ priceMinor: 2000 })
      .where(eq(productVariants.productId, productId));
    expect(await evaluateProductAlerts(productId)).toHaveLength(0);
    expect(await listProductAlerts({ acknowledged: false })).toHaveLength(0);
  });
});

describe("acknowledgeProductAlert", () => {
  async function seedAlert(): Promise<string> {
    await seedProduct({ minMarginBps: 2000, priceMinor: 1000, costMinor: 900 });
    const [alert] = await scanProductAlerts();
    return alert!.id;
  }

  test("acknowledges an alert and frees the open-alert slot", async () => {
    const id = await seedAlert();
    const out = await acknowledgeProductAlert({
      id,
      userId,
      resolutionNote: "repriced",
    });
    expect(out.acknowledgedAt).not.toBeNull();
    expect(out.resolutionNote).toBe("repriced");

    // The product still breaches → a fresh scan re-raises.
    expect(await scanProductAlerts()).toHaveLength(1);
  });

  test("an alert cannot be acknowledged twice", async () => {
    const id = await seedAlert();
    await acknowledgeProductAlert({ id, userId });
    await expectError(
      acknowledgeProductAlert({ id, userId }),
      "ALREADY_ACKNOWLEDGED",
    );
  });

  test("rejects an unknown alert id", async () => {
    await expectError(
      acknowledgeProductAlert({ id: ulid(), userId }),
      "ALERT_NOT_FOUND",
    );
  });
});

describe("purgeAcknowledgedProductAlerts", () => {
  test("purges old acknowledged alerts, keeps open ones", async () => {
    await seedProduct({ minMarginBps: 2000, priceMinor: 1000, costMinor: 900 });
    const [alert] = await scanProductAlerts();
    await acknowledgeProductAlert({ id: alert!.id, userId });
    await db
      .update(productAlerts)
      .set({ acknowledgedAt: new Date(Date.now() - 400 * 86_400_000) })
      .where(eq(productAlerts.id, alert!.id));

    expect(await purgeAcknowledgedProductAlerts()).toBe(1);
    expect(await listProductAlerts()).toHaveLength(0);
  });
});
