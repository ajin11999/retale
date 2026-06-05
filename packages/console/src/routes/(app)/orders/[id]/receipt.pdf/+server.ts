import { error } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";
import type { RequestHandler } from "./$types";

// Proxy the API's customer-receipt PDF (`GET /orders/:id/receipt.pdf`). The API
// route authenticates with a Bearer token, which a plain browser <a href>
// cannot carry — so the console fetches it server-side with the session token
// and streams the PDF back under its own cookie-authenticated origin.
export const GET: RequestHandler = async ({ params, cookies }) => {
  const token = cookies.get("access_token");
  if (!token) throw error(401, "Not signed in");

  // GRAPHQL_URL points at `…/graphql`; the PDF route sits on the same origin.
  const apiBase = (env.GRAPHQL_URL ?? "http://localhost:3000/graphql").replace(
    /\/graphql$/,
    "",
  );

  const res = await fetch(`${apiBase}/orders/${params.id}/receipt.pdf`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw error(res.status, `PDF unavailable (API responded ${res.status})`);
  }

  return new Response(res.body, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="receipt-${params.id}.pdf"`,
    },
  });
};
