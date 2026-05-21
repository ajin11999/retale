<script lang="ts">
  import { graphql } from "$houdini";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import type { Viewer } from "../+layout.server";
  import { formatMoney } from "$lib/utils";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import Select from "$lib/components/ui/select.svelte";
  import type { PageData } from "./$types";

  graphql(`
    query TrackingAccountList {
      trackingAccounts(includeArchived: true) {
        id
        parentId
        name
        code
        accountCategory
        counterCategory
        balanceMinor
        archivedAt
      }
    }
  `);

  const CreateTrackingAccount = graphql(`
    mutation ConsoleCreateTrackingAccount(
      $name: String!
      $accountCategory: String!
      $counterCategory: String!
      $parentId: ID
      $code: String
    ) {
      createTrackingAccount(
        name: $name
        accountCategory: $accountCategory
        counterCategory: $counterCategory
        parentId: $parentId
        code: $code
      ) {
        id
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const Store = $derived(data.TrackingAccountList);
  const accounts = $derived($Store.data?.trackingAccounts ?? []);

  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canCreate = $derived(has("tracking_account.create"));

  // ---- Tree build ----------------------------------------------------------
  type Account = (typeof accounts)[number];
  type Node = { acc: Account; children: Node[] };

  // Archived accounts are hidden by default; toggled by the header checkbox.
  let showArchived = $state(false);

  const tree = $derived.by(() => {
    const visible = showArchived
      ? accounts
      : accounts.filter((a) => !a.archivedAt);
    const byParent = new Map<string | null, Account[]>();
    for (const a of visible) {
      const key = a.parentId ?? null;
      const list = byParent.get(key) ?? [];
      list.push(a);
      byParent.set(key, list);
    }
    for (const list of byParent.values()) {
      list.sort((x, y) => {
        const xv = x.archivedAt ? 1 : 0;
        const yv = y.archivedAt ? 1 : 0;
        return xv - yv || x.name.localeCompare(y.name);
      });
    }
    const build = (parentId: string | null): Node[] =>
      (byParent.get(parentId) ?? []).map((acc) => ({
        acc,
        children: build(acc.id),
      }));
    return build(null);
  });

  // ---- Search --------------------------------------------------------------
  // Match by name, code, or account category; a parent is kept if any
  // descendant matches, so the hierarchy still reads.
  let search = $state("");
  const filteredTree = $derived.by<Node[]>(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tree;
    const matches = (a: Account) =>
      a.name.toLowerCase().includes(q) ||
      (a.code?.toLowerCase().includes(q) ?? false) ||
      a.accountCategory.toLowerCase().includes(q);
    const filter = (nodes: Node[]): Node[] => {
      const out: Node[] = [];
      for (const n of nodes) {
        const kids = filter(n.children);
        if (matches(n.acc) || kids.length) out.push({ acc: n.acc, children: kids });
      }
      return out;
    };
    return filter(tree);
  });

  // ---- New form ------------------------------------------------------------
  let showNew = $state(false);
  let nName = $state("");
  let nCode = $state("");
  let nAccountCategory = $state("liability.tracking.staff");
  let nCounterCategory = $state("expense.commission");
  let nParentId = $state<string>("");

  let busy = $state(false);
  let error = $state<string | null>(null);

  function resetNew() {
    showNew = false;
    nName = "";
    nCode = "";
    nAccountCategory = "liability.tracking.staff";
    nCounterCategory = "expense.commission";
    nParentId = "";
  }

  async function createAccount() {
    if (!nName.trim() || !nAccountCategory.trim() || !nCounterCategory.trim())
      return;
    busy = true;
    error = null;
    try {
      const res = await CreateTrackingAccount.mutate({
        name: nName.trim(),
        accountCategory: nAccountCategory.trim(),
        counterCategory: nCounterCategory.trim(),
        parentId: nParentId || null,
        code: nCode.trim() || null,
      });
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      const id = res.data?.createTrackingAccount.id;
      resetNew();
      if (id) await goto(`/tracking/${id}`);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>Tracking accounts · Retale Console</title></svelte:head>

<div class="space-y-4">
  <div class="flex items-center justify-between gap-3">
    <h1 class="text-xl font-semibold">Tracking accounts</h1>
    <div class="flex items-center gap-3">
      <label class="flex items-center gap-1.5 text-sm text-muted-foreground">
        <input type="checkbox" bind:checked={showArchived} class="size-4" />
        Show archived
      </label>
      <div class="w-64">
        <Input
          type="search"
          placeholder="Search accounts…"
          bind:value={search}
        />
      </div>
      <Button
        size="sm"
        disabled={busy || !canCreate}
        onclick={() => (showNew = true)}
      >
        New account
      </Button>
    </div>
  </div>

  {#if error}
    <p class="text-sm text-destructive">{error}</p>
  {/if}

  {#if showNew}
    <div class="space-y-3 rounded-lg border bg-card p-4">
      <div class="grid grid-cols-2 gap-3">
        <label class="space-y-1">
          <span class="text-sm font-medium">Name</span>
          <Input bind:value={nName} placeholder="e.g. Andi (cashier)" />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Code (optional)</span>
          <Input bind:value={nCode} />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Account category</span>
          <Input bind:value={nAccountCategory} placeholder="liability.tracking.staff" />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Counter category</span>
          <Input bind:value={nCounterCategory} placeholder="expense.commission" />
        </label>
        <label class="col-span-2 space-y-1">
          <span class="text-sm font-medium">Parent (optional)</span>
          <Select bind:value={nParentId}>
            <option value="">— Top level —</option>
            {#each accounts.filter((a) => !a.archivedAt) as a (a.id)}
              <option value={a.id}>{a.name}</option>
            {/each}
          </Select>
        </label>
      </div>
      <div class="flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={busy} onclick={resetNew}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={busy || !nName.trim()}
          onclick={createAccount}>Create &amp; edit</Button
        >
      </div>
    </div>
  {/if}

  {#if $Store.fetching && accounts.length === 0}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if $Store.errors?.length}
    <p class="text-sm text-destructive">{$Store.errors[0].message}</p>
  {:else if accounts.length === 0}
    <p class="text-sm text-muted-foreground">No tracking accounts yet.</p>
  {:else}
    <div class="overflow-hidden rounded-lg border bg-card">
      <table class="w-full text-sm">
        <thead class="border-b bg-muted/50 text-left text-muted-foreground">
          <tr>
            <th class="px-4 py-2 font-medium">Account</th>
            <th class="px-4 py-2 font-medium">Category</th>
            <th class="px-4 py-2 text-right font-medium">Balance</th>
            <th class="px-4 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {#each filteredTree as node (node.acc.id)}
            {@render row(node, 0)}
          {/each}
          {#if filteredTree.length === 0}
            <tr>
              <td colspan="4" class="px-4 py-10 text-center text-muted-foreground">
                No accounts match.
              </td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>
  {/if}
</div>

{#snippet row(node: Node, depth: number)}
  <tr class="border-b last:border-0 hover:bg-muted/40">
    <td class="px-4 py-2" style:padding-left="{depth * 1.25 + 1}rem">
      <a
        href={`/tracking/${node.acc.id}`}
        class="font-medium text-primary hover:underline"
      >
        {node.acc.name}
      </a>
      {#if node.acc.code}
        <span class="ml-1 text-xs text-muted-foreground">
          {node.acc.code}
        </span>
      {/if}
    </td>
    <td class="px-4 py-2 font-mono text-xs text-muted-foreground">
      {node.acc.accountCategory}
    </td>
    <td class="px-4 py-2 text-right">
      <span class={node.acc.balanceMinor > 0 ? "font-medium" : ""}>
        {formatMoney(node.acc.balanceMinor)}
      </span>
    </td>
    <td class="px-4 py-2">
      <Badge
        class={node.acc.archivedAt
          ? "bg-muted text-muted-foreground"
          : "bg-emerald-100 text-emerald-700"}
      >
        {node.acc.archivedAt ? "Archived" : "Active"}
      </Badge>
    </td>
  </tr>
  {#each node.children as child (child.acc.id)}
    {@render row(child, depth + 1)}
  {/each}
{/snippet}
