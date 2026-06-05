import { error, json } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";
import type { RequestHandler } from "./$types";

const apiRoot = () =>
  (env.GRAPHQL_URL ?? "http://localhost:3000/graphql").replace(/\/graphql\/?$/, "");

// Stream the stored logo from the API. The API keeps it on local disk, which
// the browser cannot reach directly, so the page loads the image from here and
// we proxy through. The `?v=` cache-buster the page appends is ignored by the
// API (the logo has a fixed filename) but stops the browser from showing a
// stale logo after a replace.
export const GET: RequestHandler = async ({ fetch, setHeaders }) => {
  const res = await fetch(`${apiRoot()}/business-logo`);
  if (!res.ok) error(res.status === 404 ? 404 : 502, "No logo set.");
  setHeaders({
    "content-type": res.headers.get("content-type") ?? "image/png",
    "cache-control": "no-cache",
  });
  return new Response(res.body, { status: 200 });
};

// Proxy for the API's multipart /business-logo endpoint. The access-token
// cookie is httpOnly, so the browser cannot POST to the API directly — the
// upload comes here and we forward it with the bearer token attached.
export const POST: RequestHandler = async ({ request, cookies, fetch }) => {
  const token = cookies.get("access_token");
  if (!token) error(401, "Not signed in.");

  const incoming = await request.formData();
  const file = incoming.get("file");
  if (!(file instanceof File)) error(400, "A 'file' field is required.");

  const forwarded = new FormData();
  forwarded.append("file", file, file.name);

  const res = await fetch(`${apiRoot()}/business-logo`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: forwarded,
  });

  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      // text was not JSON — fall back to the raw body.
    }
    error(res.status, message || `Upload failed (${res.status})`);
  }

  return json(JSON.parse(text));
};
