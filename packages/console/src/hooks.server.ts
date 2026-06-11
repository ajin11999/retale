import type { Handle } from "@sveltejs/kit";
import { ensureFreshSession } from "$lib/server/session";

// Authenticate every request: rotate the access token if it is at/near expiry
// (the API issues 60-minute tokens), then stash it in locals for the /graphql
// proxy and the server load functions. All GraphQL — SSR and browser — flows
// through this hook, so an idle tab recovers transparently on its next request.
export const handle: Handle = async ({ event, resolve }) => {
  event.locals.accessToken = await ensureFreshSession(event.cookies);
  return resolve(event);
};
