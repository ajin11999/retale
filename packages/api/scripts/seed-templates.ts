// Seed (or re-sync) the built-in role templates. Idempotent — safe to re-run
// after the permission catalog changes; templates evolve here, user-cloned
// roles are never touched. Run: bun run scripts/seed-templates.ts
import { eq } from "drizzle-orm";
import { roles, rolePermissions } from "../src/db/schema/auth.ts";
import { db } from "../src/lib/db.ts";
import { ROLE_TEMPLATES } from "../src/lib/permissions.ts";

for (const tpl of ROLE_TEMPLATES) {
  let role = await db.query.roles.findFirst({ where: eq(roles.name, tpl.name) });

  if (!role) {
    await db.insert(roles).values({
      name: tpl.name,
      description: tpl.description,
      isTemplate: true,
    });
    role = await db.query.roles.findFirst({ where: eq(roles.name, tpl.name) });
  } else {
    await db
      .update(roles)
      .set({ description: tpl.description, isTemplate: true })
      .where(eq(roles.id, role.id));
  }
  if (!role) throw new Error(`failed to upsert template role ${tpl.name}`);

  const keys = [...new Set(tpl.permissionKeys)];
  await db.delete(rolePermissions).where(eq(rolePermissions.roleId, role.id));
  await db.insert(rolePermissions).values(keys.map((permissionKey) => ({ roleId: role.id, permissionKey })));

  console.log(`seeded template '${tpl.name}' (${keys.length} permissions)`);
}

process.exit(0);
