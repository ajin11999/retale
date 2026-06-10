import { redirect } from "@sveltejs/kit";
import { gqlRequest } from "$lib/server/graphql";
import { clearSession } from "$lib/server/session";
import type { RequestHandler } from "./$types";

const LOGOUT = /* GraphQL */ `
  mutation ConsoleLogout($t: String!) {
    logout(refreshToken: $t)
  }
`;

export const POST: RequestHandler = async ({ cookies }) => {
  const refreshToken = cookies.get("refresh_token");
  if (refreshToken) {
    // Best-effort revocation — clear cookies regardless of API outcome.
    try {
      await gqlRequest(LOGOUT, { t: refreshToken });
    } catch {
      /* ignore */
    }
  }
  clearSession(cookies);
  redirect(303, "/login");
};
