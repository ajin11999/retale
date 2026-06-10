import { error, redirect } from "@sveltejs/kit";
import { gqlRequest, GqlTransportError } from "$lib/server/graphql";
import { clearSession } from "$lib/server/session";
import type { LayoutServerLoad } from "./$types";

const ME = /* GraphQL */ `
  query ConsoleMe {
    me {
      id
      username
      name
      isRoot
      permissions
    }
  }
`;

export interface Viewer {
  id: string;
  username: string;
  name: string;
  isRoot: boolean;
  permissions: string[];
}

interface MeData {
  me: Viewer | null;
}

// Auth guard for every screen under (app): the access-token cookie (already
// refreshed by hooks.server.ts when near expiry) must resolve to a real user,
// or we bounce to /login. An unreachable API is a 503, not a logout — the
// session survives the blip.
export const load: LayoutServerLoad = async ({ cookies }) => {
  const token = cookies.get("access_token");
  if (!token) redirect(303, "/login");

  let me: MeData["me"] = null;
  try {
    ({ me } = await gqlRequest<MeData>(ME, {}, token));
  } catch (e) {
    if (e instanceof GqlTransportError) {
      error(503, "The API is unreachable. Try again in a moment.");
    }
    me = null;
  }

  if (!me) {
    clearSession(cookies);
    redirect(303, "/login");
  }

  return { user: me };
};
