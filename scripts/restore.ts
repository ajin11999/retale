// Restore a Retale stack from a backup made by scripts/backup.ts (or from a
// bare mariadb-dump .sql / .sql.gz file). DESTRUCTIVE: drops and recreates the
// database, and replaces the uploads directory when the backup contains one.
//
//   bun run restore backups/retale-prod-20260612-093000          restore prod
//   bun run restore backups/retale-prod-20260612-093000 --dev    load into dev
//   bun run restore old-dump.sql.gz --db-only                    db only
//
// Prod: stops api + console first, restores, then starts them again — the api
// re-applies migrations at startup, so restoring an older backup is safe.
// Dev: run `bun run db:migrate` afterwards if the backup predates the schema.
//
// Non-interactive runs must pass --yes; interactive runs get a y/N prompt.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { REPO_ROOT, type Mode, resolveStack, run, dockerAvailable } from "./lib/stack.ts";

const USAGE = "usage: bun run restore <backup-dir | dump.sql[.gz]> [--dev] [--yes] [--db-only]";

let values: { dev?: boolean; yes?: boolean; "db-only"?: boolean };
let positionals: string[];
try {
  ({ values, positionals } = parseArgs({
    options: {
      dev: { type: "boolean" },
      yes: { type: "boolean" },
      "db-only": { type: "boolean" },
    },
    allowPositionals: true,
  }));
} catch (e) {
  console.error((e as Error).message + "\n" + USAGE);
  process.exit(1);
}
if (positionals.length !== 1) {
  console.error(USAGE);
  process.exit(1);
}

// --- locate the backup pieces --------------------------------------------------
const source = path.resolve(positionals[0]);
let dbFile: string;
let uploadsDir: string | undefined;
let manifest: { mode?: string; createdAt?: string } | undefined;

if (fs.existsSync(source) && fs.statSync(source).isDirectory()) {
  dbFile = ["db.sql.gz", "db.sql"]
    .map((n) => path.join(source, n))
    .find((p) => fs.existsSync(p))!;
  if (!dbFile) {
    console.error(`${source} contains no db.sql.gz / db.sql — not a retale backup?`);
    process.exit(1);
  }
  const u = path.join(source, "uploads");
  if (fs.existsSync(u)) uploadsDir = u;
  const m = path.join(source, "manifest.json");
  if (fs.existsSync(m)) manifest = JSON.parse(fs.readFileSync(m, "utf8"));
} else if (fs.existsSync(source) && /\.sql(\.gz)?$/.test(source)) {
  dbFile = source;
} else {
  console.error(`${source} is neither a backup directory nor a .sql/.sql.gz file`);
  process.exit(1);
}
if (values["db-only"]) uploadsDir = undefined;

const mode: Mode = values.dev ? "dev" : "prod";
const stack = resolveStack(mode);
if (!(await dockerAvailable())) {
  console.error("docker is not reachable — is the daemon running?");
  process.exit(1);
}

// --- confirm (this throws away the current database) ----------------------------
console.log(`Restore target : ${mode} stack, database "${stack.dbName}"`);
console.log(`Backup         : ${source}`);
if (manifest?.createdAt) console.log(`Created        : ${manifest.createdAt} (${manifest.mode})`);
if (manifest?.mode && manifest.mode !== mode) {
  console.log(`NOTE: this is a ${manifest.mode} backup being restored into the ${mode} stack.`);
}
console.log(`Uploads        : ${uploadsDir ? "will be replaced" : "untouched (db only)"}`);
if (!values.yes) {
  if (!process.stdin.isTTY) {
    console.error("Refusing to drop the database without --yes in a non-interactive run.");
    process.exit(1);
  }
  if (!confirm(`Drop and replace the ${mode} database "${stack.dbName}"?`)) {
    console.log("aborted");
    process.exit(1);
  }
}

const env = { MYSQL_PWD: stack.rootPassword };
const mariadbExec = ["docker", ...stack.composeArgs, "exec", "-T", "-e", "MYSQL_PWD", "mariadb"];

try {
  // Stop writers so nothing touches the DB or uploads mid-restore (prod only;
  // the dev api/console run on the host and are the operator's problem).
  if (stack.appServices.length > 0) {
    console.log(`Stopping ${stack.appServices.join(", ")}`);
    await run(["docker", ...stack.composeArgs, "stop", ...stack.appServices], env);
  }

  // Drop + recreate. Grants on the db survive a drop in MariaDB, so the app
  // user keeps its access; the dump then recreates every table.
  console.log(`Recreating database "${stack.dbName}"`);
  await run(
    [
      ...mariadbExec,
      "mariadb",
      "-uroot",
      "-e",
      `DROP DATABASE IF EXISTS \`${stack.dbName}\`; CREATE DATABASE \`${stack.dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
    ],
    env,
  );

  console.log(`Loading ${dbFile}`);
  const stdin = dbFile.endsWith(".gz")
    ? (Readable.toWeb(createReadStream(dbFile).pipe(createGunzip())) as ReadableStream)
    : Bun.file(dbFile);
  const load = Bun.spawn(
    [...mariadbExec, "mariadb", "-uroot", "--default-character-set=utf8mb4", stack.dbName],
    { stdin, stdout: "inherit", stderr: "inherit", env: { ...process.env, ...env } },
  );
  if ((await load.exited) !== 0) throw new Error("loading the SQL dump failed (see above)");

  if (uploadsDir) {
    if (stack.uploadsInContainer) {
      // One-off container with the uploads volume mounted: wipe, then copy the
      // backup in from a read-only bind mount.
      console.log("Replacing uploads volume contents");
      await run(
        [
          "docker",
          ...stack.composeArgs,
          "run",
          "--rm",
          "--no-deps",
          "--entrypoint",
          "sh",
          "-v",
          `${uploadsDir}:/restore:ro`,
          "api",
          "-c",
          "mkdir -p /data/uploads && find /data/uploads -mindepth 1 -delete && cp -a /restore/. /data/uploads/",
        ],
        env,
      );
    } else {
      const devUploads = path.join(REPO_ROOT, "packages", "api", "uploads");
      console.log(`Replacing ${devUploads}`);
      fs.rmSync(devUploads, { recursive: true, force: true });
      fs.cpSync(uploadsDir, devUploads, { recursive: true });
    }
  }

  if (stack.appServices.length > 0) {
    console.log(`Starting ${stack.appServices.join(", ")} (api re-applies migrations)`);
    await run(["docker", ...stack.composeArgs, "start", ...stack.appServices], env);
  }

  console.log(`✓ restore complete`);
  if (mode === "dev") {
    console.log("If this backup predates the current schema, run: bun run db:migrate");
  }
} catch (e) {
  console.error((e as Error).message);
  if (stack.appServices.length > 0) {
    console.error(
      `Restore did NOT finish cleanly. Check the database before restarting:\n` +
        `  docker ${stack.composeArgs.join(" ")} start ${stack.appServices.join(" ")}`,
    );
  }
  process.exit(1);
}
