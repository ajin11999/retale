<script lang="ts">
  import NumericInput from "$lib/components/ui/numeric-input.svelte";
  import { CachePolicy, graphql } from "$houdini";
  import { page } from "$app/state";
  import { Archive, ArchiveRestore, Check, Pencil, Trash2, X, List } from "@lucide/svelte";
  import type { Viewer } from "../+layout.server";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import DuplicateHint from "$lib/components/ui/duplicate-hint.svelte";
  import IconButton from "$lib/components/ui/icon-button.svelte";
  import Combobox from "$lib/components/ui/combobox.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import { matchesTokens, searchTokens } from "$lib/utils";
  import type { PageData } from "./$types";

  graphql(`
    query InterchangeGroupList {
      interchangeGroups {
        id
        name
        minQty
        preferredVariantId
        archivedAt
      }
      products(includeArchived: true) {
        id
        publicDisplayName
        variants {
          id
          sku
          label
          interchangeGroupId
        }
      }
    }
  `);

  const CreateInterchangeGroup = graphql(`
    mutation ConsoleCreateInterchangeGroup(
      $name: String!
      $minQty: Int
      $preferredVariantId: ID
    ) {
      createInterchangeGroup(
        name: $name
        minQty: $minQty
        preferredVariantId: $preferredVariantId
      ) {
        id
      }
    }
  `);

  const UpdateInterchangeGroup = graphql(`
    mutation ConsoleUpdateInterchangeGroup(
      $id: ID!
      $name: String
      $minQty: Int
      $preferredVariantId: ID
    ) {
      updateInterchangeGroup(
        id: $id
        name: $name
        minQty: $minQty
        preferredVariantId: $preferredVariantId
      ) {
        id
        name
        minQty
        preferredVariantId
      }
    }
  `);

  const SetInterchangeGroupArchived = graphql(`
    mutation ConsoleSetInterchangeGroupArchived($id: ID!, $archived: Boolean!) {
      setInterchangeGroupArchived(id: $id, archived: $archived) {
        id
        archivedAt
      }
    }
  `);

  const DeleteInterchangeGroup = graphql(`
    mutation ConsoleDeleteInterchangeGroup($id: ID!) {
      deleteInterchangeGroup(id: $id)
    }
  `);

  const SetVariantsInterchangeGroup = graphql(`
    mutation ConsoleSetVariantsInterchangeGroup($groupId: ID, $variantIds: [ID!]!) {
      setVariantsInterchangeGroup(groupId: $groupId, variantIds: $variantIds)
    }
  `);

  let { data }: { data: PageData } = $props();
  const InterchangeGroupList = $derived(data.InterchangeGroupList);

  const interchangeGroups = $derived($InterchangeGroupList.data?.interchangeGroups ?? []);
  const products = $derived($InterchangeGroupList.data?.products ?? []);

  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canCreate = $derived(has("product.create"));
  const canEdit = $derived(has("product.edit"));
  const canArchive = $derived(has("product.archive"));

  let search = $state("");
  const visibleGroups = $derived.by(() => {
    const tokens = searchTokens(search.trim());
    if (!tokens.length) return interchangeGroups;
    return interchangeGroups.filter((n) => matchesTokens(tokens, n.name));
  });

  interface Draft {
    id: string | null;
    name: string;
    minQty: number | null;
    preferredVariantId: string;
  }

  let draft = $state<Draft | null>(null);
  let busy = $state(false);
  let feedback = $state<{ ok: boolean; text: string } | null>(null);

  const variantComboOptions = $derived.by(() => {
    // Only show variants that belong to this group, plus the currently selected one (in case it was set incorrectly before)
    const options = [{ value: "", label: "— None —" }];
    for (const p of products) {
      for (const v of (p.variants || [])) {
        if (draft && (v.interchangeGroupId === draft.id || v.id === draft.preferredVariantId)) {
          const labelStr = v.label ? ` - ${v.label}` : '';
          options.push({
            value: v.id,
            label: `${p.publicDisplayName}${labelStr} (${v.sku})`
          });
        }
      }
    }
    return options;
  });

  function newGroup() {
    draft = {
      id: null,
      name: "",
      minQty: null,
      preferredVariantId: "",
    };
  }

  function editGroup(n: typeof interchangeGroups[0]) {
    draft = {
      id: n.id,
      name: n.name,
      minQty: n.minQty,
      preferredVariantId: n.preferredVariantId ?? "",
    };
  }

  const groupCandidates = $derived(
    interchangeGroups.map((c) => ({
      id: c.id,
      name: c.name,
      note: c.archivedAt ? "Archived" : null,
    })),
  );

  function editGroupById(id: string) {
    const n = interchangeGroups.find((t) => t.id === id);
    if (n) editGroup(n);
  }

  async function run(
    label: string,
    fn: () => Promise<{ errors?: readonly { message: string }[] | null }>,
  ): Promise<boolean> {
    busy = true;
    feedback = null;
    try {
      const res = await fn();
      if (res.errors?.length) {
        feedback = { ok: false, text: res.errors[0].message };
        return false;
      }
      feedback = { ok: true, text: `${label} saved.` };
      return true;
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
      return false;
    } finally {
      busy = false;
    }
  }

  async function saveGroup() {
    const d = draft;
    if (!d || !d.name.trim()) return;
    const ok = await run("Interchange group", () =>
      d.id
        ? UpdateInterchangeGroup.mutate({
            id: d.id,
            name: d.name.trim(),
            minQty: d.minQty,
            preferredVariantId: d.preferredVariantId || null,
          })
        : CreateInterchangeGroup.mutate({
            name: d.name.trim(),
            minQty: d.minQty,
            preferredVariantId: d.preferredVariantId || null,
          }),
    );
    if (ok) {
      draft = null;
      await InterchangeGroupList.fetch({ policy: CachePolicy.NetworkOnly });
    }
  }

  async function toggleArchived(n: typeof interchangeGroups[0]) {
    const ok = await run("Interchange group", () =>
      SetInterchangeGroupArchived.mutate({ id: n.id, archived: !n.archivedAt }),
    );
    if (ok) await InterchangeGroupList.fetch({ policy: CachePolicy.NetworkOnly });
  }

  async function deleteGroup(n: typeof interchangeGroups[0]) {
    if (!confirm(`Delete "${n.name}"?`)) return;
    const ok = await run("Interchange group", () => DeleteInterchangeGroup.mutate({ id: n.id }));
    if (ok) {
      if (draft?.id === n.id) draft = null;
      await InterchangeGroupList.fetch({ policy: CachePolicy.NetworkOnly });
    }
  }

  // --- Variant Management ---
  let managingGroup = $state<typeof interchangeGroups[0] | null>(null);
  let variantSearch = $state("");
  let selectedVariantIds = $state<Set<string>>(new Set());

  const filteredAvailableVariants = $derived.by(() => {
    if (!managingGroup) return [];
    const tokens = searchTokens(variantSearch.trim());
    const available = [];
    for (const p of products) {
      for (const v of (p.variants || [])) {
        if (v.interchangeGroupId !== managingGroup.id) {
          const name = `${p.publicDisplayName}${v.label ? ` - ${v.label}` : ''}`;
          const searchStr = `${name} ${v.sku}`;
          if (!tokens.length || matchesTokens(tokens, searchStr)) {
            available.push({ id: v.id, name, sku: v.sku, p });
          }
        }
      }
    }
    return available;
  });

  const groupVariants = $derived.by(() => {
    if (!managingGroup) return [];
    const assigned = [];
    for (const p of products) {
      for (const v of (p.variants || [])) {
        if (v.interchangeGroupId === managingGroup.id) {
          const name = `${p.publicDisplayName}${v.label ? ` - ${v.label}` : ''}`;
          assigned.push({ id: v.id, name, sku: v.sku, p, isPreferred: v.id === managingGroup.preferredVariantId });
        }
      }
    }
    return assigned;
  });

  function manageVariants(n: typeof interchangeGroups[0]) {
    managingGroup = n;
    variantSearch = "";
    selectedVariantIds = new Set();
  }

  async function addSelectedVariants() {
    if (!managingGroup || selectedVariantIds.size === 0) return;
    const ok = await run("Variants assigned", () =>
      SetVariantsInterchangeGroup.mutate({
        groupId: managingGroup!.id,
        variantIds: Array.from(selectedVariantIds),
      })
    );
    if (ok) {
      selectedVariantIds = new Set();
      await InterchangeGroupList.fetch({ policy: CachePolicy.NetworkOnly });
    }
  }

  async function removeVariant(variantId: string) {
    if (!confirm("Remove variant from this group?")) return;
    const ok = await run("Variant removed", () =>
      SetVariantsInterchangeGroup.mutate({
        groupId: null,
        variantIds: [variantId],
      })
    );
    if (ok) {
      await InterchangeGroupList.fetch({ policy: CachePolicy.NetworkOnly });
    }
  }
</script>

<svelte:head><title>Interchange Groups · Retale Console</title></svelte:head>

<div class="space-y-4">
  <div class="flex items-center justify-between gap-3">
    <h1 class="text-xl font-semibold">Interchange Groups</h1>
    <div class="flex items-center gap-2">
      <div class="w-64">
        <Input
          type="search"
          placeholder="Search groups…"
          bind:value={search}
        />
      </div>
      <Button size="sm" disabled={busy || !canCreate} onclick={newGroup}>
        New group
      </Button>
    </div>
  </div>

  {#if feedback}
    <p class="text-sm {feedback.ok ? 'text-emerald-700' : 'text-destructive'}">
      {feedback.text}
    </p>
  {/if}

  {#if !canEdit}
    <p
      class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
    >
      You have read-only access to products — editing is disabled.
    </p>
  {/if}

  {#if draft}
    <div class="space-y-3 rounded-lg border bg-card p-5">
      <h2 class="text-sm font-semibold">
        {draft.id ? "Edit group" : "New group"}
      </h2>
      <div class="grid grid-cols-2 gap-4">
        <label class="relative space-y-1">
          <span class="text-sm font-medium">Name</span>
          <Input bind:value={draft.name} disabled={!canEdit} />
          <DuplicateHint
            query={draft.name}
            items={groupCandidates}
            excludeId={draft.id}
            onSelect={editGroupById}
            noun="group"
          />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Min qty</span>
          <NumericInput
            bind:value={draft.minQty}
            placeholder="None"
            disabled={!canEdit}
          />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Preferred variant</span>
          <Combobox
            options={variantComboOptions}
            bind:value={draft.preferredVariantId}
            placeholder="Search variant…"
            disabled={!canEdit}
          />
        </label>
      </div>
      <div class="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onclick={() => (draft = null)}>Cancel</Button
        >
        <Button
          size="sm"
          disabled={busy || !canEdit || !draft.name.trim()}
          onclick={saveGroup}
        >
          {draft.id ? "Save group" : "Create group"}
        </Button>
      </div>
    </div>
  {/if}

  {#if managingGroup}
    <div class="space-y-4 rounded-lg border bg-card p-5">
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold">
          Manage Variants: {managingGroup.name}
        </h2>
        <Button variant="ghost" size="sm" onclick={() => (managingGroup = null)}>Close</Button>
      </div>

      <div class="grid md:grid-cols-2 gap-6">
        <div class="space-y-3">
          <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Current Variants in Group</h3>
          {#if groupVariants.length === 0}
            <p class="text-sm text-muted-foreground">No variants assigned to this group yet.</p>
          {:else}
            <div class="space-y-2">
              {#each groupVariants as v}
                <div class="flex items-center justify-between gap-2 p-2 rounded border bg-muted/20">
                  <div class="flex flex-col">
                    <span class="text-sm font-medium">{v.name}</span>
                    <span class="text-xs text-muted-foreground">{v.sku}</span>
                    {#if v.isPreferred}
                      <span class="text-[10px] text-emerald-600 font-semibold uppercase mt-0.5">Preferred</span>
                    {/if}
                  </div>
                  <IconButton
                    icon={X}
                    label="Remove from group"
                    variant="muted"
                    disabled={busy || !canEdit}
                    onclick={() => removeVariant(v.id)}
                  />
                </div>
              {/each}
            </div>
          {/if}
        </div>

        <div class="space-y-3">
          <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Add Variants</h3>
          <div class="flex gap-2">
            <Input 
              placeholder="Search by name or SKU..." 
              bind:value={variantSearch}
              class="flex-1"
            />
            <Button 
              size="sm" 
              disabled={busy || !canEdit || selectedVariantIds.size === 0} 
              onclick={addSelectedVariants}
            >
              Add Selected ({selectedVariantIds.size})
            </Button>
          </div>
          <div class="max-h-64 overflow-y-auto space-y-1 rounded border p-1">
            {#each filteredAvailableVariants as v (v.id)}
              <label class="flex items-start gap-3 p-2 rounded hover:bg-muted/40 cursor-pointer {selectedVariantIds.has(v.id) ? 'bg-sky-50' : ''}">
                <input 
                  type="checkbox" 
                  class="rounded border-gray-300 mt-1"
                  checked={selectedVariantIds.has(v.id)}
                  onchange={(e) => {
                    if (e.currentTarget.checked) selectedVariantIds.add(v.id);
                    else selectedVariantIds.delete(v.id);
                  }}
                  disabled={busy || !canEdit}
                />
                <div class="flex flex-col">
                  <span class="text-sm font-medium">{v.name}</span>
                  <span class="text-xs text-muted-foreground">{v.sku}</span>
                </div>
              </label>
            {:else}
              <div class="p-4 text-center text-sm text-muted-foreground">
                {variantSearch.trim() ? "No matching variants outside this group." : "Type to search variants..."}
              </div>
            {/each}
          </div>
        </div>
      </div>
    </div>
  {/if}

  {#if $InterchangeGroupList.fetching && interchangeGroups.length === 0}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if $InterchangeGroupList.errors?.length}
    <p class="text-sm text-destructive">{$InterchangeGroupList.errors[0].message}</p>
  {:else}
    <div class="overflow-hidden rounded-lg border bg-card">
      <table class="w-full text-sm">
        <thead class="border-b bg-muted/50 text-left text-muted-foreground">
          <tr>
            <th class="px-4 py-2 font-medium">Group</th>
            <th class="px-4 py-2 text-right font-medium">Min qty</th>
            <th class="px-4 py-2 font-medium">Status</th>
            <th class="px-4 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {#each visibleGroups as n (n.id)}
            <tr class="border-b last:border-0 hover:bg-muted/40">
              <td class="px-4 py-2">
                <span class="font-medium">{n.name}</span>
              </td>
              <td class="px-4 py-2 text-right">
                {n.minQty ?? "—"}
              </td>
              <td class="px-4 py-2">
                <Badge
                  class={n.archivedAt != null
                    ? "bg-muted text-muted-foreground"
                    : "bg-emerald-100 text-emerald-700"}
                >
                  {n.archivedAt != null ? "Archived" : "Active"}
                </Badge>
              </td>
              <td class="px-4 py-2 text-right whitespace-nowrap">
                <span class="inline-flex items-center gap-0.5">
                  <IconButton
                    icon={List}
                    label="Manage Variants"
                    variant="primary"
                    disabled={busy || !canEdit}
                    onclick={() => manageVariants(n)}
                  />
                  <IconButton
                    icon={Pencil}
                    label="Edit"
                    variant="primary"
                    disabled={busy || !canEdit}
                    onclick={() => editGroup(n)}
                  />
                  <IconButton
                    icon={n.archivedAt != null ? ArchiveRestore : Archive}
                    label={n.archivedAt != null ? "Restore" : "Archive"}
                    disabled={busy || !canArchive}
                    onclick={() => toggleArchived(n)}
                  />
                  <IconButton
                    icon={Trash2}
                    label="Delete"
                    variant="destructive"
                    disabled={busy || !canEdit}
                    onclick={() => deleteGroup(n)}
                  />
                </span>
              </td>
            </tr>
          {/each}
          {#if visibleGroups.length === 0}
            <tr>
              <td colspan="4" class="px-4 py-10 text-center text-muted-foreground">
                {search.trim() ? "No groups match." : "No groups yet."}
              </td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>
  {/if}
</div>
