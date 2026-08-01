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
      $date: String!
      $dueDate: String
      $memo: String
      $termsAndConditions: String
    ) {
      createRfq(
        vendorId: $vendorId
        date: $date
        dueDate: $dueDate
        memo: $memo
        termsAndConditions: $termsAndConditions
      ) {
        id
      }
    }
  `);

  const CreateRfqFromRequisitions = graphql(`
    mutation ConsoleCreateRfqFromRequisitions(
      $vendorId: ID
      $date: String!
      $dueDate: String
      $memo: String
      $termsAndConditions: String
      $requisitionItemIds: [ID!]!
    ) {
      createRfqFromRequisitions(
        vendorId: $vendorId
        date: $date
        dueDate: $dueDate
        memo: $memo
        termsAndConditions: $termsAndConditions
        requisitionItemIds: $requisitionItemIds
      ) {
        id
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const RfqList = $derived(data.RfqList);

  const rfqs = $derived($RfqList.data?.rfqs ?? []);
  const vendors = $derived($RfqList.data?.vendors ?? []);
  const requisitions = $derived(
    ($RfqList.data?.requisitions ?? []).filter(
      (r) => r.status === "open" || r.status === "partially_ordered" || r.status === "draft"
    )
  );

  const vendorOptions = $derived([
    { value: "", label: "— Ad-hoc / Unspecified vendor —" },
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

  // ---- New RFQ modal/form state ----
  interface NewRfqDraft {
    mode: "blank" | "requisitions";
    vendorId: string;
    date: string;
    dueDate: string;
    memo: string;
    termsAndConditions: string;
    selectedReqItemIds: string[];
  }

  let draft = $state<NewRfqDraft | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);

  function startNew(mode: "blank" | "requisitions" = "blank") {
    draft = {
      mode,
      vendorId: "",
      date: new Date().toISOString().slice(0, 10),
      dueDate: "",
      memo: "",
      termsAndConditions: "",
      selectedReqItemIds: [],
    };
  }

  function toggleReqItem(id: string) {
    if (!draft) return;
    if (draft.selectedReqItemIds.includes(id)) {
      draft.selectedReqItemIds = draft.selectedReqItemIds.filter((i) => i !== id);
    } else {
      draft.selectedReqItemIds = [...draft.selectedReqItemIds, id];
    }
  }

  async function createRfq() {
    const d = draft;
    if (!d || !d.date) return;

    if (d.mode === "requisitions" && d.selectedReqItemIds.length === 0) {
      error = "Please select at least one requisition item.";
      return;
    }

    busy = true;
    error = null;
    try {
      if (d.mode === "requisitions") {
        const res = await CreateRfqFromRequisitions.mutate({
          vendorId: d.vendorId || null,
          date: d.date,
          dueDate: d.dueDate || null,
          memo: d.memo.trim() || null,
          termsAndConditions: d.termsAndConditions.trim() || null,
          requisitionItemIds: d.selectedReqItemIds,
        });
        if (res.errors?.length) {
          error = res.errors[0].message;
          return;
        }
        const id = res.data?.createRfqFromRequisitions.id;
        if (id) await goto(`/rfqs/${id}`);
      } else {
        const res = await CreateRfq.mutate({
          vendorId: d.vendorId || null,
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
      }
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
      <div class="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={busy || !canCreate} onclick={() => startNew("requisitions")}>
          From Requisition
        </Button>
        <Button size="sm" disabled={busy || !canCreate} onclick={() => startNew("blank")}>
          New RFQ
        </Button>
      </div>
    </div>
  </div>

  {#if error}
    <p class="text-sm text-destructive">{error}</p>
  {/if}

  {#if draft}
    <div class="space-y-4 rounded-lg border bg-card p-5">
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold">
          {draft.mode === "requisitions" ? "Create RFQ from Purchase Requisitions" : "Create New RFQ"}
        </h2>
        <div class="flex items-center gap-2">
          <Button
            size="sm"
            variant={draft.mode === "blank" ? "default" : "outline"}
            onclick={() => (draft!.mode = "blank")}
          >
            Blank
          </Button>
          <Button
            size="sm"
            variant={draft.mode === "requisitions" ? "default" : "outline"}
            onclick={() => (draft!.mode = "requisitions")}
          >
            From Requisitions
          </Button>
        </div>
      </div>

      <div class="grid grid-cols-3 gap-4">
        <label class="space-y-1">
          <span class="text-sm font-medium">Vendor</span>
          <Combobox
            options={vendorOptions}
            bind:value={draft.vendorId}
            placeholder="Search vendor…"
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

      {#if draft.mode === "requisitions"}
        <div class="space-y-2 border-t pt-3">
          <h3 class="text-xs font-semibold uppercase text-muted-foreground">Select Requisition Lines to Include</h3>
          {#if requisitions.length === 0}
            <p class="text-xs text-muted-foreground">No open requisitions found.</p>
          {:else}
            <div class="max-h-48 overflow-y-auto rounded border bg-background p-2 space-y-2">
              {#each requisitions as req}
                <div class="text-xs font-medium text-muted-foreground px-1">{req.name}</div>
                {#each req.items as item}
                  {@const remaining = item.qtyRequested - item.qtyOrdered}
                  {#if remaining > 0}
                    <label class="flex items-center gap-2 px-2 py-1 hover:bg-muted/40 rounded cursor-pointer text-xs">
                      <input
                        type="checkbox"
                        checked={draft.selectedReqItemIds.includes(item.id)}
                        onchange={() => toggleReqItem(item.id)}
                      />
                      <span class="flex-1 font-medium">{item.description ?? "Variant Item"}</span>
                      <span class="text-muted-foreground font-mono">{remaining} requested</span>
                    </label>
                  {/if}
                {/each}
              {/each}
            </div>
          {/if}
        </div>
      {/if}

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
