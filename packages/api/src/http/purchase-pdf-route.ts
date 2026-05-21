// Binary route for the purchase-order PDF — `GET /purchases/:id/po.pdf`.
// The Flutter client downloads this and shares it to WhatsApp / Gmail as an
// attachment (deep links cannot carry files). Auth reuses the GraphQL stack:
// build a context, run `requirePermission`, map its GraphQLError to a status.

import { Elysia } from "elysia";
import { GraphQLError } from "graphql";
import { requirePermission } from "../lib/authz.ts";
import { buildContext } from "../lib/context.ts";
import { renderPurchaseOrderPdf } from "../services/purchase-pdf-service.ts";
import { PurchaseError } from "../services/purchase-service.ts";

export const purchasePdfRoute = new Elysia().get(
  "/purchases/:id/po.pdf",
  async ({ params, request, set }) => {
    const ctx = await buildContext({ request });
    try {
      await requirePermission(ctx, "purchase.send");
    } catch (e) {
      const code = e instanceof GraphQLError ? e.extensions?.code : undefined;
      set.status = code === "UNAUTHENTICATED" ? 401 : 403;
      return { error: e instanceof Error ? e.message : "forbidden" };
    }

    // Prices are hidden by default; `?prices=1` (or true) opts in.
    const showPrices = /^(1|true)$/i.test(
      new URL(request.url).searchParams.get("prices") ?? "",
    );

    try {
      const pdf = await renderPurchaseOrderPdf(params.id, { showPrices });
      // pdf-lib returns a Uint8Array; cast past the generic-Uint8Array vs
      // BodyInit mismatch — Bun's Response accepts it at runtime.
      return new Response(pdf as unknown as BodyInit, {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": `inline; filename="po-${params.id}.pdf"`,
        },
      });
    } catch (e) {
      if (e instanceof PurchaseError && e.code === "PURCHASE_NOT_FOUND") {
        set.status = 404;
        return { error: e.message };
      }
      throw e;
    }
  },
);
