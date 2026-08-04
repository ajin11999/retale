<script lang="ts">
  import { graphql } from "$houdini";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import type { Viewer } from "../+layout.server";
  import { matchesTokens, searchTokens, statusLabel } from "$lib/utils";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Combobox from "$lib/components/ui/combobox.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import Pagination from "$lib/components/ui/pagination.svelte";
  import Textarea from "$lib/components/ui/textarea.svelte";
  import type { PageData } from "./$types";

  graphql(`
    query RfqList {
      rfqs {
        id
        rfqNumber
        vendorId
        snapshotVendorName
        date
        dueDate
        status
        memo
        termsAndConditions
        createdAt
        items {
          id
        }
      }
      vendors {
        id
        name
      }
      requisitions(includeCancelled: false) {
        id
        name
        status
        items {
          id
          variantId
          description
          qtyRequested
          qtyOrdered
          estimatedUnitCostMinor
        }
      }
    }
  `);

  const CreateRfq = graphql(`
    mutation ConsoleCreateRfq(
      $vendorId: ID
      $snapshotVendorName: String
      $date: String!
      $dueDate: String
      $memo: String
      $termsAndConditions: String
    ) {
      createRfq(
        vendorId: $vendorId
        snapshotVendorName: $snapshotVendorName
        date: $date
        dueDate: $dueDate
        memo: $memo
        termsAndConditions: $termsAndConditions
      ) {
        id
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const RfqList = $derived(data.RfqList);

  const rfqs = $derived($RfqList.data?.rfqs ?? []);
  const vendors = $derived($RfqList.data?.vendors ?? []);

  const vendorOptions = $derived([
    { value: "", label: "— Ad-hoc / Walk-in vendor —" },
    ...vendors.map((v) => ({ value: v.id, label: v.name })),
  ]);

  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canCreate = $derived(has("purchase.create"));

  const STATUSES = ["all", "draft", "sent", "received", "awarded", "cancelled"];
  let statusFilter = $state("all");
  let search = $state("");

  const rows = $derived.by(() => {
    const byStatus =
      statusFilter === "all" ? rfqs : rfqs.filter((r) => r.status === statusFilter);
    const tokens = searchTokens(search.trim());
    if (!tokens.length) return byStatus;
    return byStatus.filter(
      (r) =>
        matchesTokens(tokens, r.rfqNumber, r.snapshotVendorName, r.memo ?? "")
    );
  });

  let pageNumber = $state(1);
  const pageSize = 25;
  $effect(() => {
    search;
    statusFilter;
    pageNumber = 1;
  });
  const paginatedRows = $derived(
    rows.slice((pageNumber - 1) * pageSize, pageNumber * pageSize)
  );

  const statusClass = (s: string) =>
    s === "draft"
      ? "bg-muted text-muted-foreground"
      : s === "sent"
      ? "bg-sky-100 text-sky-700"
      : s === "received"
      ? "bg-purple-100 text-purple-700"
      : s === "awarded"
      ? "bg-emerald-100 text-emerald-700"
      : "bg-red-100 text-red-700";

  const fmtDate = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleDateString("en-CA") : "—";

  // ---- New RFQ form state ----
  interface NewRfqDraft {
    vendorId: string;
    adHocName: string;
    date: string;
    dueDate: string;
    memo: string;
    termsAndConditions: string;
  }

  let draft = $state<NewRfqDraft | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);

  function startNew() {
    draft = {
      vendorId: "",
      adHocName: "",
      date: new Date().toISOString().slice(0, 10),
      dueDate: "",
      memo: "",
      termsAndConditions: "",
    };
  }

  async function createRfq() {
    const d = draft;
    if (!d || !d.date) return;

    busy = true;
    error = null;
    try {
      const res = await CreateRfq.mutate({
        vendorId: d.vendorId || null,
        snapshotVendorName: d.vendorId ? null : d.adHocName.trim() || null,
        date: d.date,
        dueDate: d.dueDate || null,
        memo: d.memo.trim() || null,
        termsAndConditions: d.termsAndConditions.trim() || null,
      });
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      const id = res.data?.createRfq.id;
      if (id) await goto(`/rfqs/${id}`);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>Requests for Quotation · Retale Console</title></svelte:head>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-xl font-semibold">Requests for Quotation (RFQ)</h1>
      <p class="text-xs text-muted-foreground">Request, compare, and award vendor quotes</p>
    </div>
    <div class="flex items-center gap-3">
      <div class="w-56">
        <Input type="search" placeholder="Search RFQs…" bind:value={search} />
      </div>
      <div class="flex items-center gap-1 rounded-md border p-1 bg-muted/30">
        {#each STATUSES as s (s)}
          <button
            class="rounded px-3 py-1.5 text-sm font-medium capitalize transition-colors {statusFilter === s ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:bg-muted/50'}"
            onclick={() => (statusFilter = s)}
          >
            {s === "all" ? "All" : s}
          </button>
        {/each}
      </div>
      <Button size="sm" disabled={busy || !canCreate} onclick={startNew}>
        New RFQ
      </Button>
    </div>
  </div>

  {#if error}
    <p class="text-sm text-destructive">{error}</p>
  {/if}

  {#if draft}
    <div class="space-y-4 rounded-lg border bg-card p-5">
      <h2 class="text-sm font-semibold">Create New RFQ</h2>

      <div class="grid grid-cols-4 gap-4">
        <label class="space-y-1">
          <span class="text-sm font-medium">Vendor</span>
          <Combobox
            options={vendorOptions}
            bind:value={draft.vendorId}
            placeholder="Search vendor…"
          />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Ad-hoc / Walk-in Vendor</span>
          <Input
            bind:value={draft.adHocName}
            placeholder="Used when no vendor picked"
            disabled={draft.vendorId !== ""}
          />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Date</span>
          <Input type="date" bind:value={draft.date} />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Due Date (Optional)</span>
          <Input type="date" bind:value={draft.dueDate} />
        </label>
      </div>

      <div class="grid grid-cols-2 gap-4">
        <label class="space-y-1">
          <span class="text-sm font-medium">Memo / Internal Notes</span>
          <Textarea
            bind:value={draft.memo}
            placeholder="Notes for internal procurement team…"
            rows={2}
          />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Terms &amp; Conditions</span>
          <Textarea
            bind:value={draft.termsAndConditions}
            placeholder="Default terms for vendor response…"
            rows={2}
          />
        </label>
      </div>

      <div class="flex justify-end gap-2 pt-2 border-t">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onclick={() => (draft = null)}>Cancel</Button
        >
        <Button size="sm" disabled={busy} onclick={createRfq}>
          Create RFQ
        </Button>
      </div>
    </div>
  {/if}

  {#if $RfqList.fetching && rfqs.length === 0}
    <p class="text-sm text-muted-foreground">Loading RFQs…</p>
  {:else if $RfqList.errors?.length}
    <p class="text-sm text-destructive">{$RfqList.errors[0].message}</p>
  {:else}
    <div class="overflow-hidden rounded-lg border bg-card">
      <table class="w-full text-sm">
        <thead class="border-b bg-muted/50 text-left text-muted-foreground">
          <tr>
            <th class="px-4 py-2 font-medium">RFQ Number</th>
            <th class="px-4 py-2 font-medium">Vendor</th>
            <th class="px-4 py-2 font-medium">Date</th>
            <th class="px-4 py-2 font-medium">Due Date</th>
            <th class="px-4 py-2 font-medium">Items</th>
            <th class="px-4 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {#each paginatedRows as r (r.id)}
            <tr class="border-b last:border-0 hover:bg-muted/40">
              <td class="px-4 py-2">
                <a
                  href={`/rfqs/${r.id}`}
                  class="font-mono font-medium text-primary hover:underline"
                >
                  {r.rfqNumber}
                </a>
              </td>
              <td class="px-4 py-2 font-medium">
                {r.snapshotVendorName}
              </td>
              <td class="px-4 py-2">{fmtDate(r.date)}</td>
              <td class="px-4 py-2 text-muted-foreground">{fmtDate(r.dueDate)}</td>
              <td class="px-4 py-2">{r.items.length} lines</td>
              <td class="px-4 py-2">
                <Badge class={statusClass(r.status)}>{r.status}</Badge>
              </td>
            </tr>
          {/each}
          {#if rows.length === 0}
            <tr>
              <td colspan="6" class="px-4 py-10 text-center text-muted-foreground">
                {search.trim()
                  ? "No RFQs match search criteria."
                  : `No RFQs${statusFilter === "all" ? "" : ` (${statusFilter})`}.`}
              </td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>
    <div class="flex items-center justify-between">
      <p class="text-sm text-muted-foreground">
        {rows.length} RFQ{rows.length === 1 ? "" : "s"}
      </p>
      <Pagination bind:page={pageNumber} {pageSize} totalItems={rows.length} />
    </div>
  {/if}
</div>
