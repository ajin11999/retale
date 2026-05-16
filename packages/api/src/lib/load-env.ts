// Side-effecting module: loads the monorepo-root `.env` into process.env.
//
// Bun only auto-loads `.env` from the current working directory. In this
// workspace, scripts and `drizzle-kit` run with cwd = packages/api, so the
// root `.env` would be missed. Importing this module first fixes that from
// any cwd. Real environment variables (CI, shell) always win — values here
// only fill in what is not already set.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

function applyEnvFile(path: string): void {
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) value = value.slice(1, -1);

    if (key && !(key in process.env)) process.env[key] = value;
  }
}

// Walk up from this file until a `.env` is found (the monorepo root).
let dir = import.meta.dir;
for (let depth = 0; depth < 8; depth++) {
  const candidate = join(dir, ".env");
  if (existsSync(candidate)) {
    applyEnvFile(candidate);
    break;
  }
  const parent = dirname(dir);
  if (parent === dir) break; // reached filesystem root
  dir = parent;
}
