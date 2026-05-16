// Access-token JWTs — HS512 via jose, signed with JWT_SIGNING_KEY.
// Short-lived (60 min). Carries role IDs, not flattened permissions: the
// permission set is resolved server-side per request from role_permissions.

import { SignJWT, jwtVerify } from "jose";
import { env } from "./env.ts";

const ALG = "HS512";
const ACCESS_TOKEN_TTL = "60m";

const signingKey = new TextEncoder().encode(env.jwtSigningKey);

/** Claims encoded into the access token. `sub` holds the user id. */
export interface AccessTokenClaims {
  userId: string;
  isRoot: boolean;
  roleIds: string[];
}

/** Sign a 60-minute access token for an authenticated user. */
export function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  return new SignJWT({ isRoot: claims.isRoot, roleIds: claims.roleIds })
    .setProtectedHeader({ alg: ALG })
    .setSubject(claims.userId)
    .setIssuedAt()
    .setExpirationTime(ACCESS_TOKEN_TTL)
    .sign(signingKey);
}

/**
 * Verify an access token and return its claims. Throws (jose errors) on an
 * invalid signature, expiry, or malformed token — callers treat as 401.
 */
export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  const { payload } = await jwtVerify(token, signingKey, { algorithms: [ALG] });
  return {
    userId: payload.sub as string,
    isRoot: payload.isRoot === true,
    roleIds: Array.isArray(payload.roleIds) ? (payload.roleIds as string[]) : [],
  };
}
