// Integration test for the scheduled-jobs orchestrator. Verifies that every
// job runs inside its own error boundary — one unconfigured feature (here,
// catalog publishing with no Blob token) is skipped, not failed, and never
// aborts the run. Runs against the local Docker MariaDB (DATABASE_URL).
//
//   bun test src/services/scheduled-jobs.test.ts

import "../lib/load-env.ts";
import { describe, expect, test } from "bun:test";
import { runScheduledJobs } from "./scheduled-jobs.ts";

describe("runScheduledJobs", () => {
  test("runs every job with its own error boundary and never throws", async () => {
    const summary = await runScheduledJobs();

    expect(summary.results.map((r) => r.job)).toEqual([
      "reorder-scan",
      "delivery-overdue-scan",
      "send-due-scan",
      "catalog-publish",
      "alert-retention-purge",
    ]);

    const byJob = new Map(summary.results.map((r) => [r.job, r]));
    // The scans and the purge complete cleanly against any DB state.
    expect(byJob.get("reorder-scan")?.status).toBe("ok");
    expect(byJob.get("delivery-overdue-scan")?.status).toBe("ok");
    expect(byJob.get("send-due-scan")?.status).toBe("ok");
    expect(byJob.get("alert-retention-purge")?.status).toBe("ok");
    // No BLOB_READ_WRITE_TOKEN in the test env → catalog publish is skipped,
    // not failed, so it raises no nightly alarm.
    expect(byJob.get("catalog-publish")?.status).toBe("skipped");
  });
});
