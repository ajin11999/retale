// Multipart upload route for product images — the one binary endpoint outside
// GraphQL. A normal `multipart/form-data` POST (fields: `productId`, `file`)
// is the natural transport for a file; GraphQL handles the rest of image CRUD.
// Auth reuses the GraphQL stack: build a context, run `requirePermission`,
// and map its GraphQLError to an HTTP status.

import { Elysia } from "elysia";
import { GraphQLError } from "graphql";
import { requirePermission } from "../lib/authz.ts";
import { buildContext } from "../lib/context.ts";
import { addProductImage, ImageError } from "../services/product-image-service.ts";

/** HTTP status for an ImageError code. */
function statusFor(code: ImageError["code"]): number {
  switch (code) {
    case "PRODUCT_NOT_FOUND":
      return 404;
    case "INVALID_INPUT":
    case "PROCESSING_FAILED":
      return 400;
    default:
      return 500; // NOT_CONFIGURED / UPLOAD_FAILED
  }
}

export const productImagesRoute = new Elysia().post(
  "/product-images",
  async ({ body, request, set }) => {
    const ctx = await buildContext({ request });
    try {
      await requirePermission(ctx, "product.edit");
    } catch (e) {
      const code = e instanceof GraphQLError ? e.extensions?.code : undefined;
      set.status = code === "UNAUTHENTICATED" ? 401 : 403;
      return { error: e instanceof Error ? e.message : "forbidden" };
    }

    const { productId, file } = (body ?? {}) as {
      productId?: unknown;
      file?: unknown;
    };
    if (typeof productId !== "string" || !productId.trim()) {
      set.status = 400;
      return { error: "productId is required" };
    }
    if (!(file instanceof File)) {
      set.status = 400;
      return { error: "a multipart 'file' is required" };
    }

    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const image = await addProductImage({ productId, data });
      set.status = 201;
      return image;
    } catch (e) {
      if (e instanceof ImageError) {
        set.status = statusFor(e.code);
        return { error: e.message, code: e.code };
      }
      throw e;
    }
  },
);
