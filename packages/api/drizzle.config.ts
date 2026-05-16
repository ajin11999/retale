import { defineConfig } from "drizzle-kit";
// Loads the monorepo-root .env so DATABASE_URL is available regardless of cwd.
import "./src/lib/load-env.ts";

export default defineConfig({
  dialect: "mysql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "mysql://produck:password@127.0.0.1:3306/retale",
  },
  casing: "snake_case",
});
