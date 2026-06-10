import { env } from "$env/dynamic/private";

const endpoint = () => env.GRAPHQL_URL ?? "http://localhost:3000/graphql";

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

/**
 * The API could not be reached (or didn't answer with GraphQL). Distinct from
 * a GraphQL-level rejection so auth flows can tell "token refused" (drop the
 * session) from "API down" (keep the session, surface an error).
 */
export class GqlTransportError extends Error {}

/**
 * Minimal server-side GraphQL request. Used for auth flows (login, the `me`
 * guard, logout) — data-heavy screens use the Houdini client instead.
 */
export async function gqlRequest<T>(
  query: string,
  variables: Record<string, unknown> = {},
  token?: string,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(endpoint(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch {
    throw new GqlTransportError("API unreachable");
  }
  if (!res.ok) throw new GqlTransportError(`API responded ${res.status}`);
  const json = (await res.json()) as GraphQLResponse<T>;
  if (json.errors?.length) throw new Error(json.errors[0].message);
  if (!json.data) throw new Error("Empty response from API");
  return json.data;
}
