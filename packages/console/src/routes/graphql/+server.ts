import { error } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";
import type { RequestHandler } from "./$types";

// Same-origin GraphQL proxy. The browser can't hold the access token (it lives
// in httpOnly cookies), so Houdini posts here and we forward to the API with a
// fresh Bearer token — hooks.server.ts refreshed it via ensureFreshSession
// before this handler ran. Logged-out requests are forwarded without an
// Authorization header so the API returns its normal auth error.
export const POST: RequestHandler = async ({ request, locals }) => {
  const upstream = env.GRAPHQL_URL ?? "http://localhost:3000/graphql";
  let res: Response;
  try {
    res = await fetch(upstream, {
      method: "POST",
      headers: {
        "content-type": request.headers.get("content-type") ?? "application/json",
        ...(locals.accessToken
          ? { authorization: `Bearer ${locals.accessToken}` }
          : {}),
      },
      body: await request.text(),
    });
  } catch {
    error(503, "The API is unreachable. Try again in a moment.");
  }
  // fetch auto-decompresses, so forward only status + content-type — copying
  // content-encoding/content-length headers would corrupt the response.
  return new Response(await res.text(), {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/json",
    },
  });
};
