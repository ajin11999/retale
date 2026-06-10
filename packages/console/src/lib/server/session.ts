// Session cookies + server-side token refresh. The API issues 60-minute
// access tokens with rotating 30-day refresh tokens; every SSR request runs
// through `ensureFreshSession` (hooks.server.ts) so an expiring access token
// is transparently rotated instead of bouncing the user to /login.

import type { Cookies } from "@sveltejs/kit";
import { gqlRequest, GqlTransportError } from "./graphql";

const REFRESH = /* GraphQL */ `
  mutation ConsoleRefresh($t: String!) {
    refreshToken(refreshToken: $t) {
      accessToken
      refreshToken
      refreshExpiresAt
    }
  }
`;

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  /** ISO-8601 expiry of the refresh token. */
  refreshExpiresAt: string;
}

interface RefreshData {
  refreshToken: SessionTokens;
}

/** Refresh when the access token has less than this long to live. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

/** Fallback cookie lifetime when the refresh expiry is unparseable. */
const FALLBACK_MAX_AGE_S = 30 * 24 * 60 * 60;

const cookieOpts = (maxAge: number) => ({
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  secure: false, // LAN-only; flip to true behind HTTPS
  maxAge,
});

/** Store both tokens; the cookies live exactly as long as the refresh token. */
export function storeSession(cookies: Cookies, tokens: SessionTokens): void {
  const expiresMs = Date.parse(tokens.refreshExpiresAt) - Date.now();
  const maxAge = Number.isFinite(expiresMs)
    ? Math.max(0, Math.floor(expiresMs / 1000))
    : FALLBACK_MAX_AGE_S;
  cookies.set("access_token", tokens.accessToken, cookieOpts(maxAge));
  cookies.set("refresh_token", tokens.refreshToken, cookieOpts(maxAge));
}

export function clearSession(cookies: Cookies): void {
  cookies.delete("access_token", { path: "/" });
  cookies.delete("refresh_token", { path: "/" });
}

/** The `exp` claim (ms since epoch) of an unverified JWT; null if unreadable. */
function tokenExpiryMs(jwt: string): number | null {
  const payload = jwt.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

// Single-flight refresh, keyed by the OLD refresh token. The API treats a
// stale refresh secret on a live session as token theft and revokes the whole
// session, so two parallel SSR requests must never both present the same
// token. Successful entries linger briefly: requests the browser fired before
// the rotated cookie reached it still carry the old token, and must be served
// the already-rotated pair instead of hitting the API again.
const inflight = new Map<string, Promise<SessionTokens>>();
const SUCCESS_LINGER_MS = 60 * 1000;

function refreshOnce(refreshToken: string): Promise<SessionTokens> {
  let p = inflight.get(refreshToken);
  if (p) return p;
  p = gqlRequest<RefreshData>(REFRESH, { t: refreshToken }).then(
    (d) => {
      setTimeout(() => inflight.delete(refreshToken), SUCCESS_LINGER_MS);
      return d.refreshToken;
    },
    (e: unknown) => {
      inflight.delete(refreshToken);
      throw e;
    },
  );
  inflight.set(refreshToken, p);
  return p;
}

/**
 * The access token to authenticate this request with, refreshing it first
 * when it is missing or within [EXPIRY_SKEW_MS] of expiry. Null when there is
 * no usable session — the (app) layout guard then redirects to /login.
 */
export async function ensureFreshSession(cookies: Cookies): Promise<string | null> {
  const access = cookies.get("access_token") ?? null;
  const refresh = cookies.get("refresh_token") ?? null;

  if (access) {
    const exp = tokenExpiryMs(access);
    if (exp !== null && exp - Date.now() > EXPIRY_SKEW_MS) return access;
  }
  if (!refresh) return access; // nothing to rotate with; let the guard decide

  try {
    const tokens = await refreshOnce(refresh);
    storeSession(cookies, tokens);
    return tokens.accessToken;
  } catch (e) {
    // API down: keep the session — the guard surfaces a 503 instead of
    // logging the user out over a blip.
    if (e instanceof GqlTransportError) return access;
    // The API refused the refresh token (revoked / expired / reused): drop
    // the session so the guard sends the user to /login rather than looping.
    clearSession(cookies);
    return null;
  }
}
