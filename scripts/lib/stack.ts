// Shared plumbing for scripts/backup.ts and scripts/restore.ts: resolving
// which Docker Compose stack (dev or prod) the command targets, and running
// docker with sane error reporting.

import fs from "node:fs";
import path from "node:path";

export const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

export type Mode = "dev" | "prod";

export interface Stack {
  mode: Mode;
  /** Args after `docker` — includes `compose` plus -p/-f/--env-file. */
  composeArgs: string[];
  dbName: string;
  /** MariaDB root password, passed to the container via MYSQL_PWD (not argv). */
  rootPassword: string;
  /** Writer services to stop while a restore replaces the database. */
  appServices: string[];
  /** Prod keeps uploads in the api container's volume; dev on the host disk. */
  uploadsInContainer: boolean;
}

/** Minimal KEY=VALUE parser for .env.prod (no quoting edge cases needed). */
function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trimStart().startsWith("#")) continue;
    out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

export function resolveStack(mode: Mode): Stack {
  if (mode === "dev") {
    return {
      mode,
      composeArgs: ["compose", "-f", path.join(REPO_ROOT, "docker-compose.yml")],
      dbName: "retale",
      // Hardcoded in docker-compose.yml (MARIADB_ROOT_PASSWORD) — dev only.
      rootPassword: "rootpassword",
      appServices: [], // the dev api/console run on the host, not in compose
      uploadsInContainer: false,
    };
  }

  const envFile = path.join(REPO_ROOT, ".env.prod");
  if (!fs.existsSync(envFile)) {
    throw new Error(
      ".env.prod not found — the prod stack is configured from it " +
        "(copy .env.prod.example). Use --dev to target the dev database.",
    );
  }
  const env = parseEnvFile(envFile);
  const rootPassword = env.MARIADB_ROOT_PASSWORD;
  if (!rootPassword || rootPassword === "replace-me") {
    throw new Error("MARIADB_ROOT_PASSWORD is not set in .env.prod");
  }
  return {
    mode,
    composeArgs: [
      "compose",
      "-p",
      "retale-prod",
      "-f",
      path.join(REPO_ROOT, "docker-compose.prod.yml"),
      "--env-file",
      envFile,
    ],
    dbName: "retale",
    rootPassword,
    appServices: ["api", "console"],
    uploadsInContainer: true,
  };
}

/** Run a command, streaming output to the terminal; throw on nonzero exit. */
export async function run(args: string[], env?: Record<string, string>): Promise<void> {
  const proc = Bun.spawn(args, {
    stdout: "inherit",
    stderr: "inherit",
    env: env ? { ...process.env, ...env } : undefined,
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`command failed (exit ${code}): ${args.join(" ")}`);
  }
}

/** True when the docker daemon is reachable. */
export async function dockerAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["docker", "info", "--format", "{{.ServerVersion}}"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}
