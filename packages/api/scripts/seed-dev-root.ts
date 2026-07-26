// DEV ONLY — bootstrap a root user for local development.
//
//   bun run dev:seed-root            → admin / admin123
//   bun run dev:seed-root bob pass   → custom username / password
//

import { eq } from "drizzle-orm";
import { users } from "../src/db/schema/auth.ts";
import { db, pool } from "../src/lib/db.ts";
import { registerUser, isBootstrapNeeded } from "../src/services/auth-service.ts";

const username = process.argv[2] ?? "admin";
const password = process.argv[3] ?? "admin123";
const name = "Administrator";

try {
  if (await db.query.users.findFirst({ where: eq(users.username, username) })) {
    console.log(`User "${username}" already exists — nothing to do.`);
    process.exit(0);
  }

  const bootstrap = await isBootstrapNeeded();
  if (!bootstrap) {
    console.log("A root user has already been bootstrapped. Use dev:seed-user to create additional non-root users.");
    process.exit(1);
  }

  await registerUser({
    username,
    password,
    name,
    isRoot: true,
  });

  console.log(`Created root user "${username}" (password: ${password}).`);
} finally {
  await pool.end();
}
