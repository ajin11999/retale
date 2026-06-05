// Multipart upload route for the business logo — `POST /business-logo`
// (field: `file`). A normal `multipart/form-data` POST is the natural
// transport for a file; the rest of business settings is GraphQL. Auth reuses
// the GraphQL stack: build a context, run `requirePermission`, map its
// GraphQLError to a status.

import { Elysia } from "elysia";
import { GraphQLError } from "graphql";
import { requirePermission } from "../lib/authz.ts";
import { buildContext } from "../lib/context.ts";
import { BUSINESS_LOGO_PATH } from "../lib/uploads.ts";
import { BusinessLogoError, setBusinessLogo } from "../services/business-service.ts";

/** HTTP status for a BusinessLogoError code. */
function statusFor(code: BusinessLogoError["code"]): number {
  switch (code) {
    case "INVALID_INPUT":
    case "PROCESSING_FAILED":
      return 400;
    default:
      return 500; // WRITE_FAILED
  }
}

export const businessLogoRoute = new Elysia()
  // Serve the stored logo bytes. Reads only — no auth; the logo is a low-value
  // public-ish asset (it is printed on POs sent to vendors) and the API is
  // LAN-only. Returns 404 when no logo has been set.
  .get("/business-logo", async ({ set }) => {
    const file = Bun.file(BUSINESS_LOGO_PATH);
    if (!(await file.exists())) {
      set.status = 404;
      return { error: "no logo set" };
    }
    set.headers["content-type"] = "image/png";
    // Fixed filename, mutable content — let the browser revalidate so a
    // replaced logo shows up. Callers also append ?v=<updatedAt>.
    set.headers["cache-control"] = "no-cache";
    return file;
  })
  .post(
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
