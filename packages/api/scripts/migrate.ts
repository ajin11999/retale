// Programmatic migration runner. Replaces `drizzle-kit migrate`, whose CLI
// exits non-zero without applying in this environment (Bun + MariaDB). Drizzle's
// own migrator, driven by the app's mysql2 pool, is reliable.
//
//   bun run scripts/migrate.ts   (wired to `bun run db:migrate`)

import "../src/lib/load-env.ts";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { db } from "../src/lib/db.ts";

const migrationsFolder = `${import.meta.dir}/../drizzle`;

await migrate(db, { migrationsFolder });
console.log("✓ migrations applied");
process.exit(0);
