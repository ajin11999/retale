// GraphQL request context. Built once per request by graphql-yoga; resolvers
// receive it as their third argument.

import type { SessionContext } from "../services/auth-service.ts";
import { type AccessTokenClaims, verifyAccessToken } from "./jwt.ts";

export interface GraphQLContext {
  /** Verified access-token claims, or null for an unauthenticated request. */
  viewer: AccessTokenClaims | null;
  request: Request;
}

/** graphql-yoga context factory: pull and verify the Bearer access token. */
export async function buildContext(initial: { request: Request }): Promise<GraphQLContext> {
  const header = initial.request.headers.get("authorization");
  let viewer: AccessTokenClaims | null = null;

  if (header?.startsWith("Bearer ")) {
    try {
      viewer = await verifyAccessToken(header.slice("Bearer ".length));
    } catch {
      viewer = null; // expired / invalid token → treated as unauthenticated
    }
  }

  return { viewer, request: initial.request };
}

/** Derive session metadata (for the `sessions` row) from the HTTP request. */
export function sessionContext(ctx: GraphQLContext): SessionContext {
  return {
    userAgent: ctx.request.headers.get("user-agent"),
    ip: ctx.request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
  };
}
