// Product image service: catalog gallery images. Every upload is optimized
// before it is stored — resized and re-encoded to WebP (a detail image plus a
// small card thumbnail) so neither Blob storage nor catalog bandwidth bloats.
// Originals are never kept. Images live on Vercel Blob; the DB holds only the
// URLs + dimensions.

import { del, put } from "@vercel/blob";
import { and, asc, eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { ulid } from "ulid";
import { productImages, products } from "../db/schema/products.ts";
import { db } from "../lib/db.ts";

export type ImageErrorCode =
  | "PRODUCT_NOT_FOUND"
  | "IMAGE_NOT_FOUND"
  | "INVALID_INPUT"
  | "NOT_CONFIGURED"
  | "PROCESSING_FAILED"
  | "UPLOAD_FAILED";

export class ImageError extends Error {
  constructor(
    public code: ImageErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ImageError";
  }
}

type ProductImage = typeof productImages.$inferSelect;

/** Longest edge, in px, of the detail image and the card thumbnail. */
const DETAIL_MAX = 1280;
const THUMB_MAX = 400;

export interface ProcessedImage {
  detail: { buffer: Buffer; width: number; height: number };
  thumbnail: { buffer: Buffer };
}

/**
 * Optimize an uploaded image: orient it by its EXIF tag, then produce a
 * detail WebP (≤1280px) and a thumbnail WebP (≤400px). Never enlarges a
 * smaller original. Throws PROCESSING_FAILED if the input is not an image.
 */
export async function processImage(data: Uint8Array): Promise<ProcessedImage> {
  if (data.byteLength === 0) {
    throw new ImageError("INVALID_INPUT", "image data is empty");
  }
  try {
    const detail = await sharp(data)
      .rotate()
      .resize({ width: DETAIL_MAX, height: DETAIL_MAX, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    const thumbnail = await sharp(data)
      .rotate()
      .resize({ width: THUMB_MAX, height: THUMB_MAX, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 75 })
      .toBuffer();
    return {
      detail: {
        buffer: detail.data,
        width: detail.info.width,
        height: detail.info.height,
      },
      thumbnail: { buffer: thumbnail },
    };
  } catch (e) {
    throw new ImageError(
      "PROCESSING_FAILED",
      `could not process image: ${(e as Error).message}`,
    );
  }
}

/** Upload one WebP buffer to Blob; returns its public URL. */
async function uploadWebp(buffer: Buffer, token: string): Promise<string> {
  const { url } = await put(`catalog/images/${ulid()}.webp`, buffer, {
    access: "public",
    token,
    contentType: "image/webp",
    addRandomSuffix: true,
    // Images are immutable (a change makes a new blob), so cache hard.
    cacheControlMaxAge: 31_536_000,
  });
  return url;
}

async function loadImage(id: string): Promise<ProductImage> {
  const row = await db.query.productImages.findFirst({
    where: eq(productImages.id, id),
  });
  if (!row) throw new ImageError("IMAGE_NOT_FOUND");
  return row;
}

export function listProductImages(productId: string): Promise<ProductImage[]> {
  return db
    .select()
    .from(productImages)
    .where(eq(productImages.productId, productId))
    .orderBy(asc(productImages.sortOrder));
}

/**
 * Optimize and store one gallery image for a product. The new image is
 * appended to the end of the gallery. Requires `BLOB_READ_WRITE_TOKEN`.
 */
export async function addProductImage(input: {
  productId: string;
  data: Uint8Array;
}): Promise<ProductImage> {
  const product = await db.query.products.findFirst({
    where: eq(products.id, input.productId),
  });
  if (!product) throw new ImageError("PRODUCT_NOT_FOUND");

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    throw new ImageError(
      "NOT_CONFIGURED",
      "BLOB_READ_WRITE_TOKEN is not set — cannot store images",
    );
  }

  const processed = await processImage(input.data);

  let detailUrl: string;
  let thumbnailUrl: string;
  try {
    detailUrl = await uploadWebp(processed.detail.buffer, token);
    thumbnailUrl = await uploadWebp(processed.thumbnail.buffer, token);
  } catch (e) {
    throw new ImageError(
      "UPLOAD_FAILED",
      `image upload to blob failed: ${(e as Error).message}`,
    );
  }

  // Append after the current last image.
  const maxRows = await db
    .select({ max: sql<number>`COALESCE(MAX(${productImages.sortOrder}), -1)` })
    .from(productImages)
    .where(eq(productImages.productId, input.productId));
  const sortOrder = Number(maxRows[0]?.max ?? -1) + 1;

  const id = ulid();
  await db.insert(productImages).values({
    id,
    productId: input.productId,
    detailUrl,
    thumbnailUrl,
    width: processed.detail.width,
    height: processed.detail.height,
    sortOrder,
  });
  return loadImage(id);
}

/**
 * Delete a gallery image. The Blob objects are removed best-effort — a failed
 * blob delete logs a warning but still removes the DB row, since the row is
 * the source of truth and an orphaned blob is only a minor storage cost.
 */
export async function deleteProductImage(id: string): Promise<void> {
  const image = await loadImage(id);
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (token) {
    try {
      await del([image.detailUrl, image.thumbnailUrl], { token });
    } catch (e) {
      console.warn(`[images] blob delete failed for image ${id}: ${(e as Error).message}`);
    }
  }
  await db.delete(productImages).where(eq(productImages.id, id));
}

/** Renumber a product's images to match the given id order (0-based). */
export async function reorderProductImages(
  productId: string,
  orderedIds: string[],
): Promise<ProductImage[]> {
  const existing = await listProductImages(productId);
  const ids = new Set(existing.map((i) => i.id));
  if (orderedIds.length !== ids.size || !orderedIds.every((i) => ids.has(i))) {
    throw new ImageError(
      "INVALID_INPUT",
      "orderedIds must list every image of the product exactly once",
    );
  }
  await db.transaction(async (tx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await tx
        .update(productImages)
        .set({ sortOrder: i })
        .where(
          and(
            eq(productImages.id, orderedIds[i] as string),
            eq(productImages.productId, productId),
          ),
        );
    }
  });
  return listProductImages(productId);
}
