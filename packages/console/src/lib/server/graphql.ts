import { env } from "$env/dynamic/private";

const endpoint = () => env.GRAPHQL_URL ?? "http://localhost:3000/graphql";

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

/**
 * Minimal server-side GraphQL request. Used for auth flows (login, the `me`
 * guard, logout) — data-heavy screens use the Houdini client instead.
 */
export async function gqlRequest<T>(
  query: string,
  variables: Record<string, unknown> = {},
  token?: string,
): Promise<T> {
  const res = await fetch(endpoint(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`API responded ${res.status}`);
  const json = (await res.json()) as GraphQLResponse<T>;
  if (json.errors?.length) throw new Error(json.errors[0].message);
  if (!json.data) throw new Error("Empty response from API");
  return json.data;
}
