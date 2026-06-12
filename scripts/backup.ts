// Back up a Retale stack: gzipped mariadb-dump of the database plus a copy of
// the uploads directory, written to a timestamped folder with a manifest.
//
//   bun run backup                  back up the prod stack (.env.prod required)
//   bun run backup --dev            back up the dev docker-compose database
//   bun run backup --keep 30        also prune, keeping the 30 newest backups
//   bun run backup --out D:/bk      write somewhere other than <repo>/backups
//   bun run backup --db-only        skip the uploads copy
//
// Restore with `bun run restore <backup-dir>` — see scripts/restore.ts and
// deploy/README.md ("Backup & restore").

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createWriteStream } from "node:fs";
import { createGzip } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { REPO_ROOT, type Mode, resolveStack, run, dockerAvailable } from "./lib/stack.ts";

const USAGE = "usage: bun run backup [--dev] [--keep N] [--out DIR] [--db-only]";

let values: { dev?: boolean; keep?: string; out?: string; "db-only"?: boolean };
try {
  ({ values } = parseArgs({
    options: {
      dev: { type: "boolean" },
      keep: { type: "string" },
      out: { type: "string" },
      "db-only": { type: "boolean" },
    },
  }));
} catch (e) {
  console.error((e as Error).message + "\n" + USAGE);
  process.exit(1);
}

const mode: Mode = values.dev ? "dev" : "prod";
const keep = values.keep ? Number(values.keep) : undefined;
if (values.keep !== undefined && (!Number.isInteger(keep) || keep! < 1)) {
  console.error(`--keep must be a positive integer\n${USAGE}`);
  process.exit(1);
}
const outRoot = path.resolve(values.out ?? path.join(REPO_ROOT, "backups"));

const stack = resolveStack(mode);
if (!(await dockerAvailable())) {
  console.error("docker is not reachable — is the daemon running?");
  process.exit(1);
}

const now = new Date();
const pad = (n: number) => String(n).padStart(2, "0");
const stamp =
  `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
  `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
const backupDir = path.join(outRoot, `retale-${mode}-${stamp}`);
fs.mkdirSync(backupDir, { recursive: true });

try {
  // --- database -------------------------------------------------------------
  const dbFile = path.join(backupDir, "db.sql.gz");
  console.log(`Dumping ${mode} database "${stack.dbName}" → ${dbFile}`);
  // `-e MYSQL_PWD` (no value) makes docker forward it from our environment, so
  // the password never appears in host process args.
  const dump = Bun.spawn(
    [
      "docker",
      ...stack.composeArgs,
      "exec",
      "-T",
      "-e",
      "MYSQL_PWD",
      "mariadb",
      "mariadb-dump",
      "-uroot",
      "--single-transaction",
      "--routines",
      "--triggers",
      "--events",
      "--hex-blob",
      "--default-character-set=utf8mb4",
      stack.dbName,
    ],
    {
      stdout: "pipe",
      stderr: "inherit",
      env: { ...process.env, MYSQL_PWD: stack.rootPassword },
    },
  );
  await pipeline(
    Readable.fromWeb(dump.stdout as never),
    createGzip({ level: 6 }),
    createWriteStream(dbFile),
  );
  if ((await dump.exited) !== 0) {
    throw new Error("mariadb-dump failed (see output above)");
  }
  const dbBytes = fs.statSync(dbFile).size;

  // --- uploads ---------------------------------------------------------------
  let uploads = false;
  if (!values["db-only"]) {
    if (stack.uploadsInContainer) {
      // Volume-backed; `compose cp` works against the running api container and
      // lands as <backupDir>/uploads.
      console.log("Copying uploads volume from the api container");
      await run(["docker", ...stack.composeArgs, "cp", "api:/data/uploads", backupDir]);
      uploads = true;
    } else {
      // Dev api runs on the host; uploads default to packages/api/uploads.
      const devUploads = path.join(REPO_ROOT, "packages", "api", "uploads");
      if (fs.existsSync(devUploads)) {
        console.log(`Copying ${devUploads}`);
        fs.cpSync(devUploads, path.join(backupDir, "uploads"), { recursive: true });
        uploads = true;
      } else {
        console.log("No dev uploads directory — skipping uploads");
      }
    }
  }

  fs.writeFileSync(
    path.join(backupDir, "manifest.json"),
    JSON.stringify(
      { tool: "retale-backup", version: 1, mode, createdAt: now.toISOString(), dbBytes, uploads },
      null,
      2,
    ) + "\n",
  );
  console.log(`✓ backup complete: ${backupDir} (db ${(dbBytes / 1024 / 1024).toFixed(1)} MB)`);
} catch (e) {
  fs.rmSync(backupDir, { recursive: true, force: true });
  console.error(`backup failed — removed partial ${backupDir}`);
  console.error((e as Error).message);
  process.exit(1);
}

// --- retention ---------------------------------------------------------------
if (keep !== undefined) {
  const siblings = fs
    .readdirSync(outRoot)
    .filter((n) => new RegExp(`^retale-${mode}-\\d{8}-\\d{6}$`).test(n))
    .sort()
    .reverse(); // newest first (stamps sort lexicographically)
  for (const old of siblings.slice(keep)) {
    fs.rmSync(path.join(outRoot, old), { recursive: true, force: true });
    console.log(`pruned old backup ${old}`);
  }
}
