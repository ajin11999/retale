<script lang="ts">
  import { CachePolicy, graphql } from "$houdini";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import type { Viewer } from "../+layout.server";
  import { formatMoney, matchesTokens, searchTokens } from "$lib/utils";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import DuplicateHint from "$lib/components/ui/duplicate-hint.svelte";
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

  // Candidates for the new-customer duplicate hint. Customer names repeat
  // often, so surface the phone (or archived status) to help disambiguate.
  const customerCandidates = $derived(
    customers.map((c) => ({
      id: c.id,
      name: c.name,
      note: c.archivedAt ? "Archived" : (c.phone ?? null),
    })),
  );

  // ---- Viewer permissions --------------------------------------------------
  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canCreate = $derived(has("customer.create"));

  // ---- Search + sort -------------------------------------------------------
  // Archived customers always sink below active ones; within each group the
  // chosen column decides the order (default: name). Sorting by AR balance
  // descending surfaces the biggest active debtors first.
  type SortKey = "name" | "balance" | "limit";
  let search = $state("");
  let sortKey = $state<SortKey>("name");
  let sortDir = $state<"asc" | "desc">("asc");

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      sortDir = sortDir === "asc" ? "desc" : "asc";
    } else {
      sortKey = key;
      // Money columns are most useful largest-first; names read better A→Z.
      sortDir = key === "name" ? "asc" : "desc";
    }
  }

  const sortGlyph = (key: SortKey) =>
    sortKey === key ? (sortDir === "asc" ? " ↑" : " ↓") : "";

  const rows = $derived.by(() => {
    const tokens = searchTokens(search.trim());
    const list = tokens.length
      ? customers.filter((c) => matchesTokens(tokens, c.name, c.phone, c.email))
      : customers;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      const av = a.archivedAt ? 1 : 0;
      const bv = b.archivedAt ? 1 : 0;
      if (av !== bv) return av - bv;
      let cmp = 0;
      if (sortKey === "balance") {
        cmp = (a.balanceMinor - b.balanceMinor) * dir;
      } else if (sortKey === "limit") {
        // Customers with no limit set sort to the end regardless of direction.
        const al = a.creditLimitMinor ?? null;
        const bl = b.creditLimitMinor ?? null;
        if (al == null && bl == null) cmp = 0;
        else if (al == null) return 1;
        else if (bl == null) return -1;
        else cmp = (al - bl) * dir;
      } else {
        cmp = a.name.localeCompare(b.name) * dir;
      }
      // Stable tiebreak by name so equal values keep a sensible order.
      return cmp || a.name.localeCompare(b.name);
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
      // Refresh the cached list so it includes the new row when the user
      // navigates back from the detail page.
      await CustomerList.fetch({ policy: CachePolicy.NetworkOnly });
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
      <label class="relative flex-1 space-y-1">
        <span class="text-sm font-medium">Customer name</span>
        <Input bind:value={newName} placeholder="Customer name" />
        <DuplicateHint
          query={newName ?? ""}
          items={customerCandidates}
          noun="customer"
        />
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
            <th class="px-4 py-2 font-medium">
              <button
                class="inline-flex items-center hover:text-foreground"
                onclick={() => toggleSort("name")}
              >
                Customer{sortGlyph("name")}
              </button>
            </th>
            <th class="px-4 py-2 font-medium">Phone</th>
            <th class="px-4 py-2 font-medium">Email</th>
            <th class="px-4 py-2 text-right font-medium">
              <button
                class="inline-flex items-center hover:text-foreground"
                onclick={() => toggleSort("balance")}
              >
                AR balance{sortGlyph("balance")}
              </button>
            </th>
            <th class="px-4 py-2 text-right font-medium">
              <button
                class="inline-flex items-center hover:text-foreground"
                onclick={() => toggleSort("limit")}
              >
                Credit limit{sortGlyph("limit")}
              </button>
            </th>
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
