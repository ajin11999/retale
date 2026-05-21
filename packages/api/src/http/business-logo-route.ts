// Multipart upload route for the business logo — `POST /business-logo`
// (field: `file`). A normal `multipart/form-data` POST is the natural
// transport for a file; the rest of business settings is GraphQL. Auth reuses
// the GraphQL stack: build a context, run `requirePermission`, map its
// GraphQLError to a status.

import { Elysia } from "elysia";
import { GraphQLError } from "graphql";
import { requirePermission } from "../lib/authz.ts";
import { buildContext } from "../lib/context.ts";
import { BusinessLogoError, setBusinessLogo } from "../services/business-service.ts";

/** HTTP status for a BusinessLogoError code. */
function statusFor(code: BusinessLogoError["code"]): number {
  switch (code) {
    case "INVALID_INPUT":
    case "PROCESSING_FAILED":
      return 400;
    default:
      return 500; // NOT_CONFIGURED / UPLOAD_FAILED
  }
}

export const businessLogoRoute = new Elysia().post(
  "/business-logo",
  async ({ body, request, set }) => {
    const ctx = await buildContext({ request });
    try {
      await requirePermission(ctx, "admin.settings.manage");
    } catch (e) {
      const code = e instanceof GraphQLError ? e.extensions?.code : undefined;
      set.status = code === "UNAUTHENTICATED" ? 401 : 403;
      return { error: e instanceof Error ? e.message : "forbidden" };
    }

    const { file } = (body ?? {}) as { file?: unknown };
    if (!(file instanceof File)) {
      set.status = 400;
      return { error: "a multipart 'file' is required" };
    }

    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const settings = await setBusinessLogo(data);
      set.status = 201;
      return { logoUrl: settings.logoUrl };
    } catch (e) {
      if (e instanceof BusinessLogoError) {
        set.status = statusFor(e.code);
        return { error: e.message, code: e.code };
      }
      throw e;
    }
  },
);
