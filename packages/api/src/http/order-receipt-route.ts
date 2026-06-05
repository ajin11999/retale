// Binary route for the customer receipt PDF — `GET /orders/:id/receipt.pdf`.
// The client downloads this and shares it to WhatsApp / email as an attachment
// (deep links cannot carry files). Auth reuses the GraphQL stack: build a
// context, run `requirePermission`, map its GraphQLError to a status. A receipt
// always prints prices, so there is no `?prices` toggle (unlike the PO PDF).

import { Elysia } from "elysia";
import { GraphQLError } from "graphql";
import { requirePermission } from "../lib/authz.ts";
import { buildContext } from "../lib/context.ts";
import { renderOrderReceiptPdf } from "../services/order-receipt-pdf-service.ts";
import { OrderError } from "../services/order-service.ts";

export const orderReceiptRoute = new Elysia().get(
  "/orders/:id/receipt.pdf",
  async ({ params, request, set }) => {
    const ctx = await buildContext({ request });
    try {
      await requirePermission(ctx, "order.send");
    } catch (e) {
      const code = e instanceof GraphQLError ? e.extensions?.code : undefined;
      set.status = code === "UNAUTHENTICATED" ? 401 : 403;
      return { error: e instanceof Error ? e.message : "forbidden" };
    }

    try {
      const pdf = await renderOrderReceiptPdf(params.id);
      // pdf-lib returns a Uint8Array; cast past the generic-Uint8Array vs
      // BodyInit mismatch — Bun's Response accepts it at runtime.
      return new Response(pdf as unknown as BodyInit, {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": `inline; filename="receipt-${params.id}.pdf"`,
        },
      });
    } catch (e) {
      if (e instanceof OrderError && e.code === "ORDER_NOT_FOUND") {
        set.status = 404;
        return { error: e.message };
      }
      throw e;
    }
  },
);
