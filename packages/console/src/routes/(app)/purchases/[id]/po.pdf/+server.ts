import { error } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";
import type { RequestHandler } from "./$types";

// Proxy the API's purchase-order PDF (`GET /purchases/:id/po.pdf`). The API
// route authenticates with a Bearer token, which a plain browser <a href>
// cannot carry — so the console fetches it server-side with the session
// token and streams the PDF back under its own cookie-authenticated origin.
export const GET: RequestHandler = async ({ params, cookies, url }) => {
  const token = cookies.get("access_token");
  if (!token) throw error(401, "Not signed in");

  // GRAPHQL_URL points at `…/graphql`; the PDF route sits on the same origin.
  const apiBase = (env.GRAPHQL_URL ?? "http://localhost:3000/graphql").replace(
    /\/graphql$/,
    "",
  );

  // Forward the price-visibility toggle (default hidden) to the API route.
  const prices = url.searchParams.get("prices") === "1" ? "?prices=1" : "";

  const res = await fetch(`${apiBase}/purchases/${params.id}/po.pdf${prices}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw error(res.status, `PDF unavailable (API responded ${res.status})`);
  }

  return new Response(res.body, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="po-${params.id}.pdf"`,
    },
  });
};
