import { HoudiniClient } from "$houdini";

// The Houdini GraphQL client. Requests go to the console's own /graphql proxy
// (same-origin, so the httpOnly session cookies ride along), which attaches a
// fresh Bearer token server-side — see src/routes/graphql/+server.ts.
export default new HoudiniClient({
  url: "/graphql",
});
