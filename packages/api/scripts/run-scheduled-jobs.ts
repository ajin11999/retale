// Daily maintenance runner. Runs the scheduled jobs once and exits — wire it
// to an OS scheduler (Windows Task Scheduler / cron) to fire once a day.
// Every job is idempotent, so an extra run is harmless. Exits non-zero if any
// job failed (a job that is simply not configured is skipped, not failed), so
// the scheduler's last-run status reflects real problems.
//
//   bun run scripts/run-scheduled-jobs.ts   (wired to `bun run jobs:run`)

import "../src/lib/load-env.ts";
import { runScheduledJobs } from "../src/services/scheduled-jobs.ts";

const summary = await runScheduledJobs();
const mark = { ok: "✓", skipped: "–", failed: "✗" } as const;
for (const r of summary.results) {
  console.log(`${mark[r.status]} ${r.job}: ${r.detail}`);
}

const failed = summary.results.filter((r) => r.status === "failed").length;
console.log(failed > 0 ? `${failed} job(s) failed` : "all jobs done");
process.exit(failed > 0 ? 1 : 0);
