// Global test preload (see bunfig.toml). A lifecycle hook registered here
// runs once across the whole `bun test` process — not per file. Individual
// test files must NOT close the shared pool in their own `afterAll`, or a
// file that finishes early pulls the connection out from under the others.

import { afterAll } from "bun:test";
import { pool } from "./lib/db.ts";

afterAll(async () => {
  // Close the shared connection pool so the test process exits cleanly.
  await pool.end();
});
