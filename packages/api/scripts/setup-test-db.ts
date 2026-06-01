// One-time (idempotent) setup for the test database. Ensures the database named
// in TEST_DATABASE_URL exists, then applies all migrations to it. Run after
// cloning, or whenever new migrations land:
//
//   bun run test:db:setup
//
// Connects directly from TEST_DATABASE_URL — independent of the NODE_ENV-gated
// `db` in src/lib/db.ts — so it works from a normal (non-test) invocation.

import "../src/lib/load-env.ts";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql from "mysql2/promise";

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.error("TEST_DATABASE_URL is not set in .env — nothing to set up.");
  process.exit(1);
}

const parsed = new URL(url);
const dbName = decodeURIComponent(parsed.pathname).replace(/^\//, "");
if (!dbName) {
  console.error("TEST_DATABASE_URL has no database name (e.g. .../retale_test).");
  process.exit(1);
}

const creds = {
  host: parsed.hostname,
  port: Number(parsed.port || 3306),
  user: decodeURIComponent(parsed.username),
  password: decodeURIComponent(parsed.password),
};

/**
 * Make sure the database exists. The common dev DB account can't CREATE DATABASE
 * (a global privilege), so the normal path is: an admin created it once and we
 * just connect. Only when it is genuinely missing do we try to create it, and
 * fall back to printing the admin SQL if that is denied too.
 */
async function ensureDatabase(): Promise<void> {
  try {
    const probe = await mysql.createConnection({ ...creds, database: dbName });
    await probe.end();
    return; // already exists and reachable
  } catch (e) {
    if ((e as { code?: string }).code !== "ER_BAD_DB_ERROR") throw e;
  }
  try {
    const admin = await mysql.createConnection(creds); // server-level, no db
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
    await admin.end();
  } catch (e) {
    if ((e as { code?: string }).code === "ER_DBACCESS_DENIED_ERROR") {
      console.error(
        `"${creds.user}" cannot create "${dbName}". Create it once as an admin, e.g.:\n` +
          `  docker exec retale-mariadb mariadb -uroot -p<root_pw> -e \\\n` +
          `    "CREATE DATABASE \\\`${dbName}\\\`; ` +
          `GRANT ALL PRIVILEGES ON \\\`${dbName}\\\`.* TO '${creds.user}'@'%'; FLUSH PRIVILEGES;"`,
      );
      process.exit(1);
    }
    throw e;
  }
}

await ensureDatabase();

const pool = mysql.createPool(url);
const db = drizzle(pool, { casing: "snake_case" });
await migrate(db, { migrationsFolder: `${import.meta.dir}/../drizzle` });
await pool.end();

console.log(`✓ test database "${dbName}" ready and migrated`);
process.exit(0);
