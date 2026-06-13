// Multipart upload route for offline invoice recognition — a binary endpoint
// outside GraphQL, same shape as product-images-route. A `multipart/form-data`
// POST (fields: `purchaseId`, `file`) returns a PREVIEW of purchase lines read
// from the invoice (image or PDF); nothing is persisted. The clerk confirms /
// fixes the preview in the console, then the existing createPurchaseItems
// mutation does the real insert. Auth reuses the GraphQL stack.

import { Elysia } from "elysia";
import { GraphQLError } from "graphql";
import { requirePermission } from "../lib/authz.ts";
import { buildContext } from "../lib/context.ts";
import { InvoiceError, recognizeInvoice } from "../services/invoice-recognition-service.ts";

/** Largest invoice upload we accept. */
const MAX_BYTES = 15 * 1024 * 1024;

/** HTTP status for an InvoiceError code. */
function statusFor(code: InvoiceError["code"]): number {
  switch (code) {
    case "PURCHASE_NOT_FOUND":
      return 404;
    case "INVALID_INPUT":
    case "UNSUPPORTED_TYPE":
      return 400;
    case "PROCESSING_FAILED":
      return 422;
    default:
      return 500; // NOT_CONFIGURED
  }
}

export const invoiceRecognitionRoute = new Elysia().post(
  "/invoice-recognition",
  async ({ body, request, set }) => {
    const ctx = await buildContext({ request });
    try {
      await requirePermission(ctx, "purchase.edit");
    } catch (e) {
      const code = e instanceof GraphQLError ? e.extensions?.code : undefined;
      set.status = code === "UNAUTHENTICATED" ? 401 : 403;
      return { error: e instanceof Error ? e.message : "forbidden" };
    }

    const { purchaseId, file } = (body ?? {}) as { purchaseId?: unknown; file?: unknown };
    if (typeof purchaseId !== "string" || !purchaseId.trim()) {
      set.status = 400;
      return { error: "purchaseId is required" };
    }
    if (!(file instanceof File)) {
      set.status = 400;
      return { error: "a multipart 'file' is required" };
    }
    if (file.size > MAX_BYTES) {
      set.status = 413;
      return { error: "file too large (max 15MB)" };
    }

    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const lines = await recognizeInvoice({
        purchaseId,
        data,
        mediaType: file.type,
        filename: file.name,
      });
      return { lines };
    } catch (e) {
      if (e instanceof InvoiceError) {
        set.status = statusFor(e.code);
        return { error: e.message, code: e.code };
      }
      throw e;
    }
  },
);
