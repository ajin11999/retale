// Scheduled jobs: the once-a-day maintenance work that has no human trigger.
// `runScheduledJobs` runs each job with its own error boundary — one failure
// never aborts the rest — and returns a summary. It is driven by an external
// scheduler via scripts/run-scheduled-jobs.ts; every job is idempotent, so an
// extra run is harmless.

import {
  CatalogError,
  publishCatalog,
  purgeOldCatalogPublishes,
} from "./catalog-service.ts";
import {
  purgeAcknowledgedProductAlerts,
  scanProductAlerts,
} from "./product-alert-service.ts";
import {
  purgeAcknowledgedAlerts,
  raiseDeliveryOverdueAlerts,
  raiseSendDueAlerts,
} from "./purchase-alert-service.ts";
import { purgeResolvedSuggestions, runReorderScan } from "./reorder-service.ts";

export type JobStatus = "ok" | "skipped" | "failed";

export interface JobResult {
  job: string;
  status: JobStatus;
  detail: string;
}

export interface JobsSummary {
  startedAt: string;
  finishedAt: string;
  results: JobResult[];
}

/** Run one job inside an error boundary. NOT_CONFIGURED becomes `skipped`. */
async function runJob(
  job: string,
  fn: () => Promise<string>,
): Promise<JobResult> {
  try {
    return { job, status: "ok", detail: await fn() };
  } catch (e) {
    // A feature that is simply not set up (e.g. catalog with no Blob token)
    // is skipped, not failed — it should not raise a nightly alarm.
    if (e instanceof CatalogError && e.code === "NOT_CONFIGURED") {
      return { job, status: "skipped", detail: e.message };
    }
    return {
      job,
      status: "failed",
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Run the daily maintenance jobs: rebuild reorder suggestions, raise
 * no-delivery alerts, publish the catalog snapshot, and purge stale rows
 * (acknowledged alerts, old publish-log rows, resolved suggestions). Never
 * throws — inspect the returned summary for per-job outcomes.
 */
export async function runScheduledJobs(): Promise<JobsSummary> {
  const startedAt = new Date().toISOString();
  const results: JobResult[] = [];

  results.push(
    await runJob("reorder-scan", async () => {
      const suggestions = await runReorderScan();
      return `${suggestions.length} reorder suggestion(s)`;
    }),
  );
  results.push(
    await runJob("delivery-overdue-scan", async () => {
      const raised = await raiseDeliveryOverdueAlerts();
      return `${raised.length} overdue alert(s) raised`;
    }),
  );
  results.push(
    await runJob("send-due-scan", async () => {
      const raised = await raiseSendDueAlerts();
      return `${raised.length} send-due alert(s) raised`;
    }),
  );
  results.push(
    await runJob("product-alert-scan", async () => {
      const raised = await scanProductAlerts();
      return `${raised.length} product alert(s) raised`;
    }),
  );
  results.push(
    await runJob("catalog-publish", async () => {
      const publish = await publishCatalog("scheduled", null);
      return `published ${publish.snapshotVersion} (${publish.productCount} product(s))`;
    }),
  );
  results.push(
    await runJob("retention-purge", async () => {
      const alerts =
        (await purgeAcknowledgedAlerts()) +
        (await purgeAcknowledgedProductAlerts());
      const publishes = await purgeOldCatalogPublishes();
      const suggestions = await purgeResolvedSuggestions();
      return `${alerts} alert(s), ${publishes} publish-log row(s), ${suggestions} resolved suggestion(s) purged`;
    }),
  );

  return { startedAt, finishedAt: new Date().toISOString(), results };
}
