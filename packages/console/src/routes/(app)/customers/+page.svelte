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
    query CustomerList {
      customers(includeArchived: true) {
        id
        name
        phone
        email
        balanceMinor
        creditLimitMinor
        archivedAt
      }
    }
  `);

  const CreateCustomer = graphql(`
    mutation ConsoleCreateCustomer($name: String!) {
      createCustomer(name: $name) {
        id
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const CustomerList = $derived(data.CustomerList);
  const customers = $derived($CustomerList.data?.customers ?? []);

  // ---- Viewer permissions --------------------------------------------------
  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canCreate = $derived(has("customer.create"));

  // ---- Search --------------------------------------------------------------
  let search = $state("");
  const rows = $derived.by(() => {
    const q = search.trim().toLowerCase();
    const list = q
      ? customers.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            (c.phone ?? "").toLowerCase().includes(q) ||
            (c.email ?? "").toLowerCase().includes(q),
        )
      : customers;
    // Active first, then by name.
    return [...list].sort((a, b) => {
      const av = a.archivedAt ? 1 : 0;
      const bv = b.archivedAt ? 1 : 0;
      return av - bv || a.name.localeCompare(b.name);
    });
  });

  // ---- New customer --------------------------------------------------------
  let newName = $state<string | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function createCustomer() {
    const name = (newName ?? "").trim();
    if (!name) return;
    busy = true;
    error = null;
    try {
      const res = await CreateCustomer.mutate({ name });
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      const id = res.data?.createCustomer.id;
      if (id) await goto(`/customers/${id}`);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  // True when the customer is over their credit limit.
  const overLimit = (c: (typeof customers)[number]) =>
    c.creditLimitMinor != null && c.balanceMinor > c.creditLimitMinor;
</script>

<svelte:head><title>Customers · Retale Console</title></svelte:head>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <h1 class="text-xl font-semibold">Customers</h1>
    <div class="flex items-center gap-3">
      <div class="w-64">
        <Input
          type="search"
          placeholder="Search customers…"
          bind:value={search}
        />
      </div>
      <Button
        size="sm"
        disabled={busy || !canCreate}
        onclick={() => (newName = "")}
      >
        New customer
      </Button>
    </div>
  </div>

  {#if error}
    <p class="text-sm text-destructive">{error}</p>
  {/if}

  {#if newName !== null}
    <div class="flex items-end gap-2 rounded-lg border bg-card p-4">
      <label class="flex-1 space-y-1">
        <span class="text-sm font-medium">Customer name</span>
        <Input bind:value={newName} placeholder="Customer name" />
      </label>
      <Button
        size="sm"
        disabled={busy || !(newName ?? "").trim()}
        onclick={createCustomer}>Create &amp; edit</Button
      >
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        onclick={() => (newName = null)}>Cancel</Button
      >
    </div>
  {/if}

  {#if $CustomerList.fetching && customers.length === 0}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if $CustomerList.errors?.length}
    <p class="text-sm text-destructive">{$CustomerList.errors[0].message}</p>
  {:else}
    <div class="overflow-hidden rounded-lg border bg-card">
      <table class="w-full text-sm">
        <thead class="border-b bg-muted/50 text-left text-muted-foreground">
          <tr>
            <th class="px-4 py-2 font-medium">Customer</th>
            <th class="px-4 py-2 font-medium">Phone</th>
            <th class="px-4 py-2 font-medium">Email</th>
            <th class="px-4 py-2 text-right font-medium">AR balance</th>
            <th class="px-4 py-2 text-right font-medium">Credit limit</th>
            <th class="px-4 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as c (c.id)}
            <tr class="border-b last:border-0 hover:bg-muted/40">
              <td class="px-4 py-2">
                <a
                  href={`/customers/${c.id}`}
                  class="font-medium text-primary hover:underline"
                >
                  {c.name}
                </a>
              </td>
              <td class="px-4 py-2">{c.phone ?? "—"}</td>
              <td class="px-4 py-2">{c.email ?? "—"}</td>
              <td class="px-4 py-2 text-right">
                <span class={overLimit(c) ? "font-medium text-destructive" : ""}>
                  {formatMoney(c.balanceMinor)}
                </span>
              </td>
              <td class="px-4 py-2 text-right">
                {c.creditLimitMinor == null
                  ? "—"
                  : formatMoney(c.creditLimitMinor)}
              </td>
              <td class="px-4 py-2">
                <Badge
                  class={c.archivedAt
                    ? "bg-muted text-muted-foreground"
                    : "bg-emerald-100 text-emerald-700"}
                >
                  {c.archivedAt ? "Archived" : "Active"}
                </Badge>
              </td>
            </tr>
          {/each}
          {#if rows.length === 0}
            <tr>
              <td
                colspan="6"
                class="px-4 py-10 text-center text-muted-foreground"
              >
                No customers match.
              </td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>
    <p class="text-sm text-muted-foreground">
      {rows.length} customer{rows.length === 1 ? "" : "s"}
    </p>
  {/if}
</div>
