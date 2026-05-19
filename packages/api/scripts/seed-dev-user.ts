// DEV ONLY — create a non-root user with every permission, for signing into
// the console without the 2FA enrolment that root users require.
//
//   bun run dev:seed-user            → manager / manager12345
//   bun run dev:seed-user bob pass   → custom username / password
//
// Idempotent: re-running with an existing username just reports and exits.

import { eq } from "drizzle-orm";
import { users } from "../src/db/schema/auth.ts";
import { db, pool } from "../src/lib/db.ts";
import { PERMISSIONS } from "../src/lib/permissions.ts";
import * as rbac from "../src/services/rbac-service.ts";

const username = process.argv[2] ?? "manager";
const password = process.argv[3] ?? "manager12345";
const ROLE_NAME = "Console (dev)";

try {
  if (await db.query.users.findFirst({ where: eq(users.username, username) })) {
    console.log(`User "${username}" already exists — nothing to do.`);
    process.exit(0);
  }

  // A user must be created "by" someone — attribute it to the first user.
  const creator = await db.query.users.findFirst();
  if (!creator) {
    console.error("No users exist. Bootstrap a root user first.");
    process.exit(1);
  }

  const existingRole = (await rbac.listRoles()).find((r) => r.name === ROLE_NAME);
  const role =
    existingRole ??
    (await rbac.createRole({
      name: ROLE_NAME,
      description: "Full-permission role for local console development.",
      permissionKeys: [...PERMISSIONS],
    }));

  await rbac.createUser({
    username,
    password,
    name: username,
    isRoot: false,
    roleIds: [role.id],
    createdByUserId: creator.id,
  });

  console.log(`Created non-root user "${username}" (password: ${password}).`);
} finally {
  await pool.end();
}
