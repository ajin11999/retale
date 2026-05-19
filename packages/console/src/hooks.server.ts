import { setSession } from "$houdini";
import type { Handle } from "@sveltejs/kit";

// Lift the access-token cookie into the Houdini session so server-side
// (SSR) GraphQL requests are authenticated.
export const handle: Handle = async ({ event, resolve }) => {
  const token = event.cookies.get("access_token");
  if (token) setSession(event, { token });
  return resolve(event);
};
