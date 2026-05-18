// Integration tests for product-image-service — image processing and the
// gallery CRUD. The Blob upload itself needs BLOB_READ_WRITE_TOKEN (unset in
// tests), so the upload path is covered only up to its NOT_CONFIGURED guard;
// processing, delete, reorder and list are exercised in full. Runs against
// the local Docker MariaDB and WIPEs the product tables between tests.
//
//   bun test src/services/product-image-service.test.ts

import "../lib/load-env.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { ulid } from "ulid";
import { users } from "../db/schema/auth.ts";
import { productImages, products } from "../db/schema/products.ts";
import { db } from "../lib/db.ts";
import {
  addProductImage,
  deleteProductImage,
  ImageError,
  type ImageErrorCode,
  listProductImages,
  processImage,
  reorderProductImages,
} from "./product-image-service.ts";

let userId: string;

async function wipe(): Promise<void> {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of ["product_images", "product_variants", "products"]) {
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
    name: "Image Test",
  });
});

afterAll(async () => {
  await wipe();
  await db.delete(users).where(eq(users.id, userId));
});

beforeEach(wipe);

async function seedProduct(): Promise<string> {
  const id = ulid();
  await db.insert(products).values({
    id,
    name: "Widget",
    priceMode: "tax_exclusive",
  });
  return id;
}

/** Insert a product_images row directly (bypasses the Blob upload). */
async function seedImage(productId: string, sortOrder: number): Promise<string> {
  const id = ulid();
  await db.insert(productImages).values({
    id,
    productId,
    detailUrl: `https://blob.test/detail-${id}.webp`,
    thumbnailUrl: `https://blob.test/thumb-${id}.webp`,
    width: 1280,
    height: 960,
    sortOrder,
  });
  return id;
}

/** A real PNG buffer of the given size, for the image processor. */
function pngBuffer(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 20, g: 120, b: 200 },
    },
  })
    .png()
    .toBuffer();
}

async function expectError(
  p: Promise<unknown>,
  code: ImageErrorCode,
): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ImageError);
  expect((err as ImageError).code).toBe(code);
}

describe("processImage", () => {
  test("downsizes to WebP and produces a thumbnail", async () => {
    const original = await pngBuffer(2000, 1500);
    const out = await processImage(new Uint8Array(original));

    // Detail: capped at 1280 on the long edge, re-encoded as WebP.
    expect(out.detail.width).toBe(1280);
    expect(out.detail.height).toBe(960);
    expect((await sharp(out.detail.buffer).metadata()).format).toBe("webp");

    // Thumbnail: capped at 400 on the long edge.
    const thumbMeta = await sharp(out.thumbnail.buffer).metadata();
    expect(thumbMeta.format).toBe("webp");
    expect(Math.max(thumbMeta.width ?? 0, thumbMeta.height ?? 0)).toBe(400);

    // Optimized output is far smaller than the raw PNG.
    expect(out.detail.buffer.byteLength).toBeLessThan(original.byteLength);
  });

  test("does not enlarge a small original", async () => {
    const out = await processImage(new Uint8Array(await pngBuffer(200, 150)));
    expect(out.detail.width).toBe(200);
    expect(out.detail.height).toBe(150);
  });

  test("rejects empty and non-image input", async () => {
    await expectError(processImage(new Uint8Array(0)), "INVALID_INPUT");
    await expectError(
      processImage(new Uint8Array([1, 2, 3, 4, 5])),
      "PROCESSING_FAILED",
    );
  });
});

describe("addProductImage", () => {
  test("rejects an unknown product before touching storage", async () => {
    await expectError(
      addProductImage({ productId: ulid(), data: new Uint8Array([1]) }),
      "PRODUCT_NOT_FOUND",
    );
  });

  test("reports NOT_CONFIGURED when the blob token is absent", async () => {
    // BLOB_READ_WRITE_TOKEN is unset in the test env.
    const productId = await seedProduct();
    await expectError(
      addProductImage({ productId, data: new Uint8Array([1]) }),
      "NOT_CONFIGURED",
    );
  });
});

describe("gallery CRUD", () => {
  test("lists images in sort order", async () => {
    const productId = await seedProduct();
    const second = await seedImage(productId, 1);
    const first = await seedImage(productId, 0);
    const list = await listProductImages(productId);
    expect(list.map((i) => i.id)).toEqual([first, second]);
  });

  test("deletes an image and rejects an unknown id", async () => {
    const productId = await seedProduct();
    const id = await seedImage(productId, 0);
    await deleteProductImage(id); // no blob token — blob delete is skipped
    expect(await listProductImages(productId)).toHaveLength(0);

    await expectError(deleteProductImage(ulid()), "IMAGE_NOT_FOUND");
  });

  test("reorders the gallery and rejects a mismatched id list", async () => {
    const productId = await seedProduct();
    const a = await seedImage(productId, 0);
    const b = await seedImage(productId, 1);
    const c = await seedImage(productId, 2);

    const reordered = await reorderProductImages(productId, [c, a, b]);
    expect(reordered.map((i) => i.id)).toEqual([c, a, b]);
    expect(reordered.map((i) => i.sortOrder)).toEqual([0, 1, 2]);

    await expectError(
      reorderProductImages(productId, [a, b]),
      "INVALID_INPUT",
    );
  });
});
