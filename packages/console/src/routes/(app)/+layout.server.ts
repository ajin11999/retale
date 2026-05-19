import { redirect } from "@sveltejs/kit";
import { gqlRequest } from "$lib/server/graphql";
import type { LayoutServerLoad } from "./$types";

const ME = /* GraphQL */ `
  query ConsoleMe {
    me {
      id
      username
      name
      isRoot
    }
  }
`;

interface MeData {
  me: { id: string; username: string; name: string; isRoot: boolean } | null;
}

// Auth guard for every screen under (app): the access-token cookie must
// resolve to a real user, or we bounce to /login.
export const load: LayoutServerLoad = async ({ cookies }) => {
  const token = cookies.get("access_token");
  if (!token) redirect(303, "/login");

  let me: MeData["me"] = null;
  try {
    ({ me } = await gqlRequest<MeData>(ME, {}, token));
  } catch {
    me = null;
  }

  if (!me) {
    cookies.delete("access_token", { path: "/" });
    cookies.delete("refresh_token", { path: "/" });
    redirect(303, "/login");
  }

  return { user: me };
};
