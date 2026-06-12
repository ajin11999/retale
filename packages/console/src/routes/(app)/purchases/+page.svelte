<script lang="ts">
  import { graphql } from "$houdini";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import type { Viewer } from "../+layout.server";
  import { formatMoney, matchesTokens, searchTokens, statusLabel } from "$lib/utils";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Combobox from "$lib/components/ui/combobox.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import Select from "$lib/components/ui/select.svelte";
  import type { PageData } from "./$types";

  // Query document — Houdini scans this for codegen. The live store is
  // supplied by +page.ts through `data` (route-store wiring is unavailable).
  graphql(`
    query PurchaseList {
      purchases(includeCancelled: true) {
        id
        snapshotVendorName
        date
        status
        totalInvoiceCost
        hasUnsentChanges
        lastSentAt
      }
      vendors {
        id
        name
      }
    }
  `);

  const CreatePurchase = graphql(`
    mutation ConsoleCreatePurchase(
      $vendorId: ID
      $snapshotVendorName: String
      $date: String!
    ) {
      createPurchase(
        vendorId: $vendorId
        snapshotVendorName: $snapshotVendorName
        date: $date
      ) {
        id
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const PurchaseList = $derived(data.PurchaseList);

  const purchases = $derived($PurchaseList.data?.purchases ?? []);
  const vendors = $derived($PurchaseList.data?.vendors ?? []);

  // Searchable vendor picker options; empty value = ad-hoc vendor.
  const vendorOptions = $derived([
    { value: "", label: "— Ad-hoc vendor —" },
    ...vendors.map((v) => ({ value: v.id, label: v.name })),
  ]);

  // ---- Viewer permissions --------------------------------------------------
  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canCreate = $derived(has("purchase.create"));

  // ---- Status + vendor-name filter -----------------------------------------
  const STATUSES = ["all", "open", "complete", "cancelled"];
  let statusFilter = $state("all");
  let search = $state("");

  const rows = $derived.by(() => {
    const byStatus =
      statusFilter === "all"
        ? purchases
        : purchases.filter((p) => p.status === statusFilter);
    const tokens = searchTokens(search.trim());
    if (!tokens.length) return byStatus;
    return byStatus.filter((p) => matchesTokens(tokens, p.snapshotVendorName));
  });

  const statusClass = (s: string) =>
    s === "open"
      ? "bg-sky-100 text-sky-700"
      : s === "complete"
        ? "bg-emerald-100 text-emerald-700"
        : "bg-muted text-muted-foreground";

  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("id-ID");

  // ---- New-purchase panel --------------------------------------------------
  interface NewDraft {
    vendorId: string;
    adHocName: string;
    date: string;
  }
  let draft = $state<NewDraft | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);

  function startNew() {
    draft = {
      vendorId: "",
      adHocName: "",
      date: new Date().toISOString().slice(0, 10),
    };
  }

  async function createPurchase() {
    const d = draft;
    if (!d || !d.date) return;
    // A purchase needs either a vendor on file or an ad-hoc vendor name.
    if (!d.vendorId && !d.adHocName.trim()) {
      error = "Pick a vendor or enter an ad-hoc vendor name.";
      return;
    }
    busy = true;
    error = null;
    try {
      const res = await CreatePurchase.mutate({
        vendorId: d.vendorId || null,
        snapshotVendorName: d.vendorId ? null : d.adHocName.trim(),
        date: d.date,
      });
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      const id = res.data?.createPurchase.id;
      if (id) await goto(`/purchases/${id}`);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>Purchases · Retale Console</title></svelte:head>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <h1 class="text-xl font-semibold">Purchases</h1>
    <div class="flex items-center gap-3">
      <div class="w-56">
        <Input
          type="search"
          placeholder="Search vendor…"
          bind:value={search}
        />
      </div>
      <div class="w-40">
        <Select bind:value={statusFilter}>
          {#each STATUSES as s (s)}
            <option value={s}>{s === "all" ? "All statuses" : s}</option>
          {/each}
        </Select>
      </div>
      <Button size="sm" disabled={busy || !canCreate} onclick={startNew}>
        New purchase
      </Button>
    </div>
  </div>

  {#if error}
    <p class="text-sm text-destructive">{error}</p>
  {/if}

  {#if draft}
    <div class="space-y-3 rounded-lg border bg-card p-5">
      <h2 class="text-sm font-semibold">New purchase</h2>
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
          <span class="text-sm font-medium">Ad-hoc vendor name</span>
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
      </div>
      <div class="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onclick={() => (draft = null)}>Cancel</Button
        >
        <Button size="sm" disabled={busy} onclick={createPurchase}>
          Create &amp; edit
        </Button>
      </div>
    </div>
  {/if}

  {#if $PurchaseList.fetching && purchases.length === 0}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if $PurchaseList.errors?.length}
    <p class="text-sm text-destructive">{$PurchaseList.errors[0].message}</p>
  {:else}
    <div class="overflow-hidden rounded-lg border bg-card">
      <table class="w-full text-sm">
        <thead class="border-b bg-muted/50 text-left text-muted-foreground">
          <tr>
            <th class="px-4 py-2 font-medium">Vendor</th>
            <th class="px-4 py-2 font-medium">Date</th>
            <th class="px-4 py-2 text-right font-medium">Invoice total</th>
            <th class="px-4 py-2 font-medium">Status</th>
            <th class="px-4 py-2 font-medium">Sent</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as p (p.id)}
            <tr class="border-b last:border-0 hover:bg-muted/40">
              <td class="px-4 py-2">
                <a
                  href={`/purchases/${p.id}`}
                  class="font-medium text-primary hover:underline"
                >
                  {p.snapshotVendorName}
                </a>
              </td>
              <td class="px-4 py-2">{fmtDate(p.date)}</td>
              <td class="px-4 py-2 text-right">
                {formatMoney(p.totalInvoiceCost)}
              </td>
              <td class="px-4 py-2">
                <Badge class={statusClass(p.status)}>{statusLabel(p.status)}</Badge>
              </td>
              <td class="px-4 py-2">
                {#if p.lastSentAt}
                  {fmtDate(p.lastSentAt)}
                  {#if p.hasUnsentChanges}
                    <Badge class="ml-1 bg-amber-100 text-amber-800">
                      unsent edits
                    </Badge>
                  {/if}
                {:else}
                  <span class="text-muted-foreground">Not sent</span>
                {/if}
              </td>
            </tr>
          {/each}
          {#if rows.length === 0}
            <tr>
              <td colspan="5" class="px-4 py-10 text-center text-muted-foreground">
                {search.trim()
                  ? "No purchases match."
                  : `No purchases${statusFilter === "all" ? "" : ` (${statusFilter})`}.`}
              </td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>
    <p class="text-sm text-muted-foreground">
      {rows.length} purchase{rows.length === 1 ? "" : "s"}
    </p>
  {/if}
</div>
