<script lang="ts">
  import { graphql } from "$houdini";
  import { page } from "$app/state";
  import type { Viewer } from "../+layout.server";
  import { formatMoney } from "$lib/utils";
  import Badge from "$lib/components/ui/badge.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import type { PageData } from "./$types";

  graphql(`
    query SessionList {
      posSessions(limit: 100) {
        id
        posId
        openedAt
        closedAt
        openingCashMinor
        closingCashMinor
        varianceMinor
        forceClosed
      }
      pointsOfSale(includeArchived: true) {
        id
        code
        name
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const SessionList = $derived(data.SessionList);
  const sessions = $derived($SessionList.data?.posSessions ?? []);
  const pointsOfSale = $derived($SessionList.data?.pointsOfSale ?? []);
  const posById = $derived(new Map(pointsOfSale.map((p) => [p.id, p])));

  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canView = $derived(has("session.open"));

  let posFilter = $state<string>("");
  const rows = $derived.by(() => {
    const list = posFilter
      ? sessions.filter((s) => s.posId === posFilter)
      : sessions;
    // Open sessions first; then most-recently opened.
    return [...list].sort((a, b) => {
      const ao = a.closedAt ? 1 : 0;
      const bo = b.closedAt ? 1 : 0;
      if (ao !== bo) return ao - bo;
      return new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime();
    });
  });

  const fmt = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleString("id-ID") : "—";

  function statusOf(s: { closedAt: string | null; forceClosed: boolean }) {
    if (!s.closedAt) return { label: "Open", class: "bg-emerald-100 text-emerald-700" };
    if (s.forceClosed) return { label: "Force-closed", class: "bg-amber-100 text-amber-800" };
    return { label: "Closed", class: "bg-muted text-muted-foreground" };
  }
</script>

<svelte:head><title>Sessions · Retale Console</title></svelte:head>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <h1 class="text-xl font-semibold">POS sessions</h1>
    <div class="w-56">
      <select
        bind:value={posFilter}
        class="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
      >
        <option value="">All registers</option>
        {#each pointsOfSale as p (p.id)}
          <option value={p.id}>{p.code} — {p.name}</option>
        {/each}
      </select>
    </div>
  </div>

  {#if !canView}
    <p class="text-sm text-muted-foreground">
      You don't have permission to view sessions.
    </p>
  {:else if $SessionList.fetching && sessions.length === 0}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if $SessionList.errors?.length}
    <p class="text-sm text-destructive">{$SessionList.errors[0].message}</p>
  {:else}
    <div class="overflow-hidden rounded-lg border bg-card">
      <table class="w-full text-sm">
        <thead class="border-b bg-muted/50 text-left text-muted-foreground">
          <tr>
            <th class="px-4 py-2 font-medium">POS</th>
            <th class="px-4 py-2 font-medium">Opened</th>
            <th class="px-4 py-2 font-medium">Closed</th>
            <th class="px-4 py-2 text-right font-medium">Opening</th>
            <th class="px-4 py-2 text-right font-medium">Closing</th>
            <th class="px-4 py-2 text-right font-medium">Variance</th>
            <th class="px-4 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as s (s.id)}
            {@const p = posById.get(s.posId)}
            {@const st = statusOf(s)}
            <tr class="border-b last:border-0 hover:bg-muted/40">
              <td class="px-4 py-2">
                <a
                  href={`/sessions/${s.id}`}
                  class="font-medium text-primary hover:underline"
                >
                  {p?.code ?? s.posId}
                </a>
                {#if p?.name}
                  <span class="ml-1 text-xs text-muted-foreground">
                    {p.name}
                  </span>
                {/if}
              </td>
              <td class="px-4 py-2">{fmt(s.openedAt)}</td>
              <td class="px-4 py-2">{fmt(s.closedAt)}</td>
              <td class="px-4 py-2 text-right">
                {formatMoney(s.openingCashMinor)}
              </td>
              <td class="px-4 py-2 text-right">
                {s.closingCashMinor == null
                  ? "—"
                  : formatMoney(s.closingCashMinor)}
              </td>
              <td class="px-4 py-2 text-right">
                {#if s.varianceMinor == null}
                  —
                {:else}
                  <span
                    class={s.varianceMinor === 0
                      ? ""
                      : "font-medium text-destructive"}
                  >
                    {formatMoney(s.varianceMinor)}
                  </span>
                {/if}
              </td>
              <td class="px-4 py-2">
                <Badge class={st.class}>{st.label}</Badge>
              </td>
            </tr>
          {/each}
          {#if rows.length === 0}
            <tr>
              <td colspan="7" class="px-4 py-10 text-center text-muted-foreground">
                No sessions to show.
              </td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>
    <p class="text-sm text-muted-foreground">
      {rows.length} session{rows.length === 1 ? "" : "s"}
    </p>
  {/if}
</div>
