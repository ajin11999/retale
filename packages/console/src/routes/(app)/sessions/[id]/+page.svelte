<script lang="ts">
  import { graphql } from "$houdini";
  import { page } from "$app/state";
  import type { Viewer } from "../../+layout.server";
  import { formatMoney, statusLabel } from "$lib/utils";
  import Badge from "$lib/components/ui/badge.svelte";
  import type { PageData } from "./$types";

  graphql(`
    query SessionDetail($id: ID!) {
      posSession(id: $id) {
        id
        posId
        openedByUserId
        openedAt
        openingCashMinor
        closedByUserId
        closedAt
        closingCashMinor
        varianceMinor
        forceClosed
        zReportJson
        notes
      }
      orders(posSessionId: $id, limit: 500) {
        id
        displayNumber
        status
        totalMinor
        closedAt
        cancelledAt
        snapshotCustomerName
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const SessionDetail = $derived(data.SessionDetail);
  const session = $derived($SessionDetail.data?.posSession ?? null);
  const orders = $derived($SessionDetail.data?.orders ?? []);

  const viewer = $derived(page.data.user as Viewer | undefined);
  // The per-variant breakdown surfaces cost — gated on the margin report key.
  const canViewVariants = $derived(
    !!viewer && viewer.permissions.includes("report.margin.view"),
  );

  // zReportJson arrives as a JSON string per the schema; parse for display.
  const zReport = $derived.by(() => {
    const raw = session?.zReportJson;
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return raw;
    }
  });

  const fmt = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleString("id-ID") : "—";

  function statusBadge(s: string) {
    if (s === "closed") return "bg-emerald-100 text-emerald-700";
    if (s === "cancelled") return "bg-destructive/10 text-destructive";
    return "bg-amber-100 text-amber-800";
  }
</script>

<svelte:head>
  <title>Session · Retale Console</title>
</svelte:head>

<div class="space-y-4">
  <a href="/sessions" class="text-sm text-primary hover:underline">← All sessions</a>

  {#if $SessionDetail.fetching && !session}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if $SessionDetail.errors?.length}
    <p class="text-sm text-destructive">{$SessionDetail.errors[0].message}</p>
  {:else if !session}
    <p class="text-sm text-muted-foreground">Session not found.</p>
  {:else}
    <div class="flex items-start justify-between">
      <div>
        <h1 class="text-xl font-semibold">Session {session.id.slice(-8)}</h1>
        <p class="text-sm text-muted-foreground">
          Opened {fmt(session.openedAt)}{session.closedAt
            ? ` · closed ${fmt(session.closedAt)}`
            : ""}
        </p>
      </div>
      <div class="flex items-center gap-3">
        {#if canViewVariants}
          <a
            href={`/sessions/${session.id}/variants`}
            class="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted/50"
          >
            Variant sales
          </a>
        {/if}
        {#if !session.closedAt}
          <Badge class="bg-emerald-100 text-emerald-700">Open</Badge>
        {:else if session.forceClosed}
          <Badge class="bg-amber-100 text-amber-800">Force-closed</Badge>
        {:else}
          <Badge class="bg-muted text-muted-foreground">Closed</Badge>
        {/if}
      </div>
    </div>

    <div class="grid grid-cols-4 gap-3">
      <div class="rounded-lg border bg-card p-3">
        <p class="text-xs text-muted-foreground">Opening cash</p>
        <p class="text-lg font-semibold">
          {formatMoney(session.openingCashMinor)}
        </p>
      </div>
      <div class="rounded-lg border bg-card p-3">
        <p class="text-xs text-muted-foreground">Closing cash</p>
        <p class="text-lg font-semibold">
          {session.closingCashMinor == null
            ? "—"
            : formatMoney(session.closingCashMinor)}
        </p>
      </div>
      <div class="rounded-lg border bg-card p-3">
        <p class="text-xs text-muted-foreground">Variance</p>
        <p
          class="text-lg font-semibold {session.varianceMinor && session.varianceMinor !== 0
            ? 'text-destructive'
            : ''}"
        >
          {session.varianceMinor == null
            ? "—"
            : formatMoney(session.varianceMinor)}
        </p>
      </div>
      <div class="rounded-lg border bg-card p-3">
        <p class="text-xs text-muted-foreground">Orders</p>
        <p class="text-lg font-semibold">{orders.length}</p>
      </div>
    </div>

    {#if session.notes}
      <div class="rounded-lg border bg-card p-3 text-sm">
        <p class="mb-1 text-xs text-muted-foreground">Notes</p>
        {session.notes}
      </div>
    {/if}

    <!-- Orders in this session -->
    <div>
      <h2 class="mb-2 text-sm font-semibold">Orders in this session</h2>
      <div class="overflow-hidden rounded-lg border bg-card">
        <table class="w-full text-sm">
          <thead class="border-b bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th class="px-4 py-2 font-medium">Number</th>
              <th class="px-4 py-2 font-medium">Customer</th>
              <th class="px-4 py-2 font-medium">Closed</th>
              <th class="px-4 py-2 text-right font-medium">Total</th>
              <th class="px-4 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {#each orders as o (o.id)}
              <tr class="border-b last:border-0 hover:bg-muted/40">
                <td class="px-4 py-2">
                  <a
                    href={`/orders/${o.id}`}
                    class="font-mono text-xs text-primary hover:underline"
                  >
                    {o.displayNumber ?? o.id.slice(-8)}
                  </a>
                </td>
                <td class="px-4 py-2">{o.snapshotCustomerName ?? "—"}</td>
                <td class="px-4 py-2">{fmt(o.closedAt ?? o.cancelledAt)}</td>
                <td class="px-4 py-2 text-right">{formatMoney(o.totalMinor)}</td>
                <td class="px-4 py-2">
                  <Badge class={statusBadge(o.status)}>{statusLabel(o.status)}</Badge>
                </td>
              </tr>
            {/each}
            {#if orders.length === 0}
              <tr>
                <td colspan="5" class="px-4 py-8 text-center text-muted-foreground">
                  No orders in this session.
                </td>
              </tr>
            {/if}
          </tbody>
        </table>
      </div>
    </div>

    {#if zReport}
      <details class="rounded-lg border bg-card p-3 text-sm">
        <summary class="cursor-pointer text-sm font-semibold">
          Z-report snapshot
        </summary>
        <pre
          class="mt-2 overflow-x-auto rounded bg-muted/50 p-3 text-xs">{typeof zReport === "string"
            ? zReport
            : JSON.stringify(zReport, null, 2)}</pre>
      </details>
    {/if}
  {/if}
</div>
