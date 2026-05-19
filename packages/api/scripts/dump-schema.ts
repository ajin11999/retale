// Writes the GraphQL SDL to packages/console/schema.graphql so the console's
// Houdini codegen can run against a local file — no live API needed.
// Run via `bun run schema:dump` at the workspace root.

import { printSchema } from "graphql";
import { schema } from "../src/schema/index.ts";

const out = new URL("../../console/schema.graphql", import.meta.url);
await Bun.write(out, printSchema(schema) + "\n");
console.log(`Wrote ${Bun.fileURLToPath(out)}`);
