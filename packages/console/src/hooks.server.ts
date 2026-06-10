import { setSession } from "$houdini";
import type { Handle } from "@sveltejs/kit";
import { ensureFreshSession } from "$lib/server/session";

// Authenticate every SSR request: rotate the access token if it is at/near
// expiry (the API issues 60-minute tokens), then lift it into the Houdini
// session so server-side GraphQL requests carry it.
export const handle: Handle = async ({ event, resolve }) => {
  const token = await ensureFreshSession(event.cookies);
  if (token) setSession(event, { token });
  return resolve(event);
};
