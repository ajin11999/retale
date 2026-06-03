<script lang="ts">
  import { graphql } from "$houdini";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import type { Viewer } from "../+layout.server";
  import { formatMoney } from "$lib/utils";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import type { PageData } from "./$types";

  // Query document — Houdini scans this for codegen. The live store is
  // supplied by +page.ts through `data` (route-store wiring is unavailable).
  graphql(`
    query VendorList {
      vendors(includeArchived: true) {
        id
        name
        kind
        phone
        email
        leadTimeDays
        balanceMinor
        archivedAt
      }
    }
  `);

  const CreateVendor = graphql(`
    mutation ConsoleCreateVendor($name: String!, $kind: VendorKind) {
      createVendor(name: $name, kind: $kind) {
        id
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const VendorList = $derived(data.VendorList);
  const vendors = $derived($VendorList.data?.vendors ?? []);

  // ---- Viewer permissions --------------------------------------------------
  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canCreate = $derived(has("vendor.create"));

  // ---- Search & kind filter ------------------------------------------------
  let search = $state("");
  let kindFilter = $state<"all" | "supplier" | "expedition">("all");
  const KIND_TABS: { value: "all" | "supplier" | "expedition"; label: string }[] = [
    { value: "all", label: "All" },
    { value: "supplier", label: "Suppliers" },
    { value: "expedition", label: "Couriers" },
  ];
  const rows = $derived.by(() => {
    const q = search.trim().toLowerCase();
    const list = vendors.filter((v) => {
      if (kindFilter !== "all" && v.kind !== kindFilter) return false;
      if (!q) return true;
      return (
        v.name.toLowerCase().includes(q) ||
        (v.phone ?? "").toLowerCase().includes(q) ||
        (v.email ?? "").toLowerCase().includes(q)
      );
    });
    // Active first, then by name.
    return [...list].sort((a, b) => {
      const av = a.archivedAt ? 1 : 0;
      const bv = b.archivedAt ? 1 : 0;
      return av - bv || a.name.localeCompare(b.name);
    });
  });

  // ---- New vendor ----------------------------------------------------------
  let newName = $state<string | null>(null);
  let newKind = $state<"supplier" | "expedition">("supplier");
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function createVendor() {
    const name = (newName ?? "").trim();
    if (!name) return;
    busy = true;
    error = null;
    try {
      const res = await CreateVendor.mutate({ name, kind: newKind });
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      const id = res.data?.createVendor.id;
      if (id) await goto(`/vendors/${id}`);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>Vendors · Retale Console</title></svelte:head>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <h1 class="text-xl font-semibold">Vendors</h1>
    <div class="flex items-center gap-3">
      <div class="inline-flex overflow-hidden rounded-md border">
        {#each KIND_TABS as t (t.value)}
          <button
            type="button"
            class="px-3 py-1.5 text-sm {kindFilter === t.value
              ? 'bg-primary text-primary-foreground'
              : 'bg-card hover:bg-muted'}"
            onclick={() => (kindFilter = t.value)}
          >
            {t.label}
          </button>
        {/each}
      </div>
      <div class="w-64">
        <Input
          type="search"
          placeholder="Search vendors…"
          bind:value={search}
        />
      </div>
      <Button
        size="sm"
        disabled={busy || !canCreate}
        onclick={() => {
          newKind = kindFilter === "expedition" ? "expedition" : "supplier";
          newName = "";
        }}
      >
        New vendor
      </Button>
    </div>
  </div>

  {#if error}
    <p class="text-sm text-destructive">{error}</p>
  {/if}

  {#if newName !== null}
    <div class="flex items-end gap-2 rounded-lg border bg-card p-4">
      <label class="flex-1 space-y-1">
        <span class="text-sm font-medium">Vendor name</span>
        <Input bind:value={newName} placeholder="Vendor name" />
      </label>
      <label class="space-y-1">
        <span class="text-sm font-medium">Kind</span>
        <select
          bind:value={newKind}
          class="h-9 rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="supplier">Supplier</option>
          <option value="expedition">Expedition / courier</option>
        </select>
      </label>
      <Button
        size="sm"
        disabled={busy || !(newName ?? "").trim()}
        onclick={createVendor}>Create &amp; edit</Button
      >
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        onclick={() => (newName = null)}>Cancel</Button
      >
    </div>
  {/if}

  {#if $VendorList.fetching && vendors.length === 0}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if $VendorList.errors?.length}
    <p class="text-sm text-destructive">{$VendorList.errors[0].message}</p>
  {:else}
    <div class="overflow-hidden rounded-lg border bg-card">
      <table class="w-full text-sm">
        <thead class="border-b bg-muted/50 text-left text-muted-foreground">
          <tr>
            <th class="px-4 py-2 font-medium">Vendor</th>
            <th class="px-4 py-2 font-medium">Kind</th>
            <th class="px-4 py-2 font-medium">Phone</th>
            <th class="px-4 py-2 font-medium">Email</th>
            <th class="px-4 py-2 text-right font-medium">Lead time</th>
            <th class="px-4 py-2 text-right font-medium">AP balance</th>
            <th class="px-4 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as v (v.id)}
            <tr class="border-b last:border-0 hover:bg-muted/40">
              <td class="px-4 py-2">
                <a
                  href={`/vendors/${v.id}`}
                  class="font-medium text-primary hover:underline"
                >
                  {v.name}
                </a>
              </td>
              <td class="px-4 py-2">
                <Badge
                  class={v.kind === "expedition"
                    ? "bg-sky-100 text-sky-700"
                    : "bg-violet-100 text-violet-700"}
                >
                  {v.kind === "expedition" ? "Courier" : "Supplier"}
                </Badge>
              </td>
              <td class="px-4 py-2">{v.phone ?? "—"}</td>
              <td class="px-4 py-2">{v.email ?? "—"}</td>
              <td class="px-4 py-2 text-right">
                {v.leadTimeDays == null ? "—" : `${v.leadTimeDays}d`}
              </td>
              <td class="px-4 py-2 text-right">
                <span class={v.balanceMinor > 0 ? "font-medium" : ""}>
                  {formatMoney(v.balanceMinor)}
                </span>
              </td>
              <td class="px-4 py-2">
                <Badge
                  class={v.archivedAt
                    ? "bg-muted text-muted-foreground"
                    : "bg-emerald-100 text-emerald-700"}
                >
                  {v.archivedAt ? "Archived" : "Active"}
                </Badge>
              </td>
            </tr>
          {/each}
          {#if rows.length === 0}
            <tr>
              <td
                colspan="7"
                class="px-4 py-10 text-center text-muted-foreground"
              >
                No vendors match.
              </td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>
    <p class="text-sm text-muted-foreground">
      {rows.length} vendor{rows.length === 1 ? "" : "s"}
    </p>
  {/if}
</div>
