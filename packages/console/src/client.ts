import { HoudiniClient } from "$houdini";
import { env } from "$env/dynamic/public";

// The Houdini GraphQL client. The JWT is pulled from the session set in
// hooks.server.ts and sent as a Bearer token on every request.
export default new HoudiniClient({
  url: env.PUBLIC_GRAPHQL_URL ?? "http://localhost:3000/graphql",
  fetchParams({ session }) {
    return {
      headers: {
        Authorization: session?.token ? `Bearer ${session.token}` : "",
      },
    };
  },
});
