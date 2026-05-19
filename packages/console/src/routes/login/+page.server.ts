import { fail, redirect } from "@sveltejs/kit";
import { gqlRequest } from "$lib/server/graphql";
import type { Actions, PageServerLoad } from "./$types";

const LOGIN = /* GraphQL */ `
  mutation ConsoleLogin($u: String!, $p: String!) {
    login(username: $u, password: $p) {
      requiresTwoFactor
      auth {
        accessToken
        refreshToken
      }
    }
  }
`;

interface LoginData {
  login: {
    requiresTwoFactor: boolean;
    auth: { accessToken: string; refreshToken: string } | null;
  };
}

// One year — the API issues 365-day access tokens (see CLAUDE.md auth model).
const COOKIE = {
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  secure: false, // LAN-only; flip to true behind HTTPS
  maxAge: 60 * 60 * 24 * 365,
};

export const load: PageServerLoad = ({ cookies }) => {
  if (cookies.get("access_token")) redirect(303, "/products");
};

export const actions: Actions = {
  default: async ({ request, cookies }) => {
    const form = await request.formData();
    const username = String(form.get("username") ?? "").trim();
    const password = String(form.get("password") ?? "");

    if (!username || !password) {
      return fail(400, { message: "Enter a username and password.", username });
    }

    try {
      const { login } = await gqlRequest<LoginData>(LOGIN, {
        u: username,
        p: password,
      });
      if (login.requiresTwoFactor || !login.auth) {
        return fail(400, {
          message: "2FA accounts are not supported in the console yet.",
          username,
        });
      }
      cookies.set("access_token", login.auth.accessToken, COOKIE);
      cookies.set("refresh_token", login.auth.refreshToken, COOKIE);
    } catch (e) {
      return fail(400, {
        message: e instanceof Error ? e.message : "Login failed.",
        username,
      });
    }

    redirect(303, "/products");
  },
};
