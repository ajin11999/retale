import { fail, redirect } from "@sveltejs/kit";
import { gqlRequest } from "$lib/server/graphql";
import { storeSession, type SessionTokens } from "$lib/server/session";
import type { Actions, PageServerLoad } from "./$types";

const LOGIN = /* GraphQL */ `
  mutation ConsoleLogin($u: String!, $p: String!) {
    login(username: $u, password: $p) {
      requiresTwoFactor
      challengeToken
      auth {
        accessToken
        refreshToken
        refreshExpiresAt
      }
    }
  }
`;

const LOGIN_2FA = /* GraphQL */ `
  mutation ConsoleLoginTwoFactor($t: String!, $c: String!) {
    loginTwoFactor(challengeToken: $t, code: $c) {
      accessToken
      refreshToken
      refreshExpiresAt
    }
  }
`;

interface LoginData {
  login: {
    requiresTwoFactor: boolean;
    challengeToken: string | null;
    auth: SessionTokens | null;
  };
}

interface TwoFactorData {
  loginTwoFactor: SessionTokens;
}

const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "Something went wrong.";

export const load: PageServerLoad = ({ cookies }) => {
  if (cookies.get("access_token")) redirect(303, "/");
};

export const actions: Actions = {
  // Step 1 — username + password. Either signs in directly, or hands back a
  // 2FA challenge token for step 2.
  password: async ({ request, cookies }) => {
    const data = await request.formData();
    const username = String(data.get("username") ?? "").trim();
    const password = String(data.get("password") ?? "");

    if (!username || !password) {
      return fail(400, { message: "Enter a username and password.", username });
    }

    let login: LoginData["login"];
    try {
      ({ login } = await gqlRequest<LoginData>(LOGIN, { u: username, p: password }));
    } catch (e) {
      return fail(400, { message: errorText(e), username });
    }

    if (login.requiresTwoFactor && login.challengeToken) {
      return { step: "twoFactor", challengeToken: login.challengeToken, username };
    }
    if (!login.auth) {
      return fail(400, { message: "Login failed.", username });
    }

    storeSession(cookies, login.auth);
    redirect(303, "/");
  },

  // Step 2 — the TOTP or recovery code for the challenge from step 1.
  twoFactor: async ({ request, cookies }) => {
    const data = await request.formData();
    const challengeToken = String(data.get("challengeToken") ?? "");
    const username = String(data.get("username") ?? "");
    const code = String(data.get("code") ?? "").trim();

    if (!challengeToken) {
      return fail(400, { message: "Your sign-in session expired — start again." });
    }
    // Keep the user on the 2FA step across validation / wrong-code errors.
    const stay = { step: "twoFactor", challengeToken, username };
    if (!code) {
      return fail(400, { ...stay, message: "Enter your authentication code." });
    }

    let auth: TwoFactorData["loginTwoFactor"];
    try {
      ({ loginTwoFactor: auth } = await gqlRequest<TwoFactorData>(LOGIN_2FA, {
        t: challengeToken,
        c: code,
      }));
    } catch (e) {
      return fail(400, { ...stay, message: errorText(e) });
    }

    storeSession(cookies, auth);
    redirect(303, "/");
  },
};
