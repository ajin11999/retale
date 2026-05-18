// CSV routes for the journal export — `GET /reports/journal.csv` (one row per
// debit/credit line) and `GET /reports/summary.csv` (one row per month ×
// account). Both are thin formatters over the same `journalExport` query the
// GraphQL `journalExport` field uses; see services/journal-service.ts.
//
// Query params: `periodStart` / `periodEnd` (`YYYY-MM-DD`, required) and
// `currency` (`minor` | `major`, default `major` — GnuCash imports major
// units). Auth reuses the GraphQL stack, like http/purchase-pdf-route.ts.

import { Elysia } from "elysia";
import { GraphQLError } from "graphql";
import { requirePermission } from "../lib/authz.ts";
import { buildContext } from "../lib/context.ts";
import {
  type JournalCurrency,
  journalExport,
  toJournalCsv,
  toSummaryCsv,
} from "../services/journal-service.ts";

interface CsvQuery {
  periodStart?: string;
  periodEnd?: string;
  currency?: string;
}

/** Validate the shared query params; returns the range + currency or an error. */
function parseQuery(
  query: CsvQuery,
): { periodStart: string; periodEnd: string; currency: JournalCurrency } | { error: string } {
  const { periodStart, periodEnd } = query;
  if (!periodStart || !periodEnd) {
    return { error: "periodStart and periodEnd are required (YYYY-MM-DD)" };
  }
  const currency = query.currency ?? "major";
  if (currency !== "minor" && currency !== "major") {
    return { error: "currency must be 'minor' or 'major'" };
  }
  return { periodStart, periodEnd, currency };
}

/** Run the permission check, mapping a GraphQLError to a 401/403 status. */
async function authorize(
  request: Request,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const ctx = await buildContext({ request });
  try {
    await requirePermission(ctx, "report.journal_export");
    return { ok: true };
  } catch (e) {
    const code = e instanceof GraphQLError ? e.extensions?.code : undefined;
    return {
      ok: false,
      status: code === "UNAUTHENTICATED" ? 401 : 403,
      message: e instanceof Error ? e.message : "forbidden",
    };
  }
}

function csvResponse(body: string, filename: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

export const journalCsvRoute = new Elysia()
  .get("/reports/journal.csv", async ({ query, request, set }) => {
    const auth = await authorize(request);
    if (!auth.ok) {
      set.status = auth.status;
      return { error: auth.message };
    }
    const parsed = parseQuery(query);
    if ("error" in parsed) {
      set.status = 400;
      return { error: parsed.error };
    }
    const data = await journalExport(parsed);
    return csvResponse(
      toJournalCsv(data, parsed.currency),
      `journal-${parsed.periodStart}_${parsed.periodEnd}.csv`,
    );
  })
  .get("/reports/summary.csv", async ({ query, request, set }) => {
    const auth = await authorize(request);
    if (!auth.ok) {
      set.status = auth.status;
      return { error: auth.message };
    }
    const parsed = parseQuery(query);
    if ("error" in parsed) {
      set.status = 400;
      return { error: parsed.error };
    }
    const data = await journalExport(parsed);
    return csvResponse(
      toSummaryCsv(data, parsed.currency),
      `summary-${parsed.periodStart}_${parsed.periodEnd}.csv`,
    );
  });
