/** @type {import('houdini').ConfigFile} */
export default {
  // Codegen reads the SDL from a local file (committed to the repo). Regenerate
  // it from the API with `bun run schema:dump` at the workspace root whenever
  // the GraphQL schema changes.
  schemaPath: "./schema.graphql",
  plugins: {
    "houdini-svelte": {},
  },
};
