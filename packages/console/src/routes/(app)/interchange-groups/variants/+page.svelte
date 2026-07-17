<script lang="ts">
  import { CachePolicy, graphql } from "$houdini";
  import { page } from "$app/state";
  import type { Viewer } from "../../+layout.server";
  import Input from "$lib/components/ui/input.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Combobox from "$lib/components/ui/combobox.svelte";
  import Pagination from "$lib/components/ui/pagination.svelte";
  import type { PageData } from "./$types";
  import { InterchangeGroupsVariantSearchStore } from "$houdini";

  graphql(`
    query InterchangeGroupsOptions {
      interchangeGroups {
        id
        name
      }
    }
  `);

  graphql(`
    query InterchangeGroupsVariantSearch($search: String!) {
      searchVariants(search: $search, limit: 100) {
        id
        sku
        label
        interchangeGroupId
        product {
          id
          publicDisplayName
        }
      }
    }
  `);

  const SetGroupMutation = graphql(`
    mutation SetVariantInterchangeGroupInline($groupId: ID, $variantIds: [ID!]!) {
      setVariantsInterchangeGroup(groupId: $groupId, variantIds: $variantIds)
    }
  `);

  let { data }: { data: PageData } = $props();
  const Options = $derived(data.InterchangeGroupsOptions);
  
  const groups = $derived($Options.data?.interchangeGroups ?? []);
  
  const groupOptions = $derived([
    { value: "", label: "— None —" },
    ...groups.map(g => ({ value: g.id, label: g.name }))
  ]);

  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canEdit = $derived(has("product.edit"));

  let search = $state("");
  let busy = $state(false);
  let feedback = $state<{ ok: boolean; text: string } | null>(null);

  const searchStore = new InterchangeGroupsVariantSearchStore();

  $effect(() => {
    // Only search if there are at least 2 characters to avoid too many requests
    if (search.trim().length >= 2 || search.trim() === "") {
      searchStore.fetch({
        variables: { search: search.trim() },
        policy: CachePolicy.NetworkOnly
      });
    }
  });

  const variants = $derived($searchStore.data?.searchVariants ?? []);
  
  let pageNumber = $state(1);
  const pageSize = 50;
  $effect(() => {
    search;
    pageNumber = 1;
  });
  const paginatedVariants = $derived(variants.slice((pageNumber - 1) * pageSize, pageNumber * pageSize));
  
  // Track local changes before they are synced, so the UI updates immediately or 
  // we can use a controlled value for Combobox
  let pendingGroupIds = $state<Record<string, string>>({});

  async function updateGroup(variantId: string, groupId: string) {
    if (busy || !canEdit) return;
    busy = true;
    feedback = null;
    try {
      const res = await SetGroupMutation.mutate({
        groupId: groupId || null,
        variantIds: [variantId]
      });
      if (res.errors?.length) {
        feedback = { ok: false, text: res.errors[0].message };
      } else {
        pendingGroupIds[variantId] = groupId;
        feedback = { ok: true, text: "Variant updated." };
        setTimeout(() => feedback = null, 2000); // clear success message after 2s
      }
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
    } finally {
      busy = false;
    }
  }

  function getGroupId(variantId: string, originalId: string | null) {
    if (variantId in pendingGroupIds) {
      return pendingGroupIds[variantId];
    }
    return originalId ?? "";
  }
</script>

<svelte:head><title>Manage Variants · Retale Console</title></svelte:head>

<div class="space-y-4">
  <a href="/interchange-groups" class="text-sm text-primary hover:underline">← Interchange Groups</a>

  <div class="flex items-center justify-between gap-3">
    <h1 class="text-xl font-semibold">Manage variant interchange groups</h1>
  </div>

  {#if !canEdit}
    <p class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
      You don't have permission to edit products.
    </p>
  {:else}
    <p class="text-sm text-muted-foreground">
      Search for variants and assign them to interchange groups quickly.
    </p>
    
    <div class="w-full max-w-md">
      <Input
        type="search"
        placeholder="Search variants by SKU or name..."
        bind:value={search}
      />
    </div>

    {#if feedback}
      <p class="text-sm {feedback.ok ? 'text-emerald-700' : 'text-destructive'} transition-opacity">
        {feedback.text}
      </p>
    {/if}

    <div class="rounded-lg border bg-card">
      <table class="w-full text-sm">
        <thead class="border-b bg-muted/50 text-left text-muted-foreground">
          <tr>
            <th class="px-4 py-2 font-medium">Variant</th>
            <th class="px-4 py-2 font-medium">SKU</th>
            <th class="w-72 px-4 py-2 font-medium">Interchange Group</th>
          </tr>
        </thead>
        <tbody>
          {#if $searchStore.fetching && variants.length === 0}
            <tr>
              <td colspan="3" class="px-4 py-10 text-center text-muted-foreground">Loading…</td>
            </tr>
          {:else if variants.length === 0}
            <tr>
              <td colspan="3" class="px-4 py-10 text-center text-muted-foreground">
                {search.trim() ? "No variants found." : "Type to search for variants."}
              </td>
            </tr>
          {:else}
            {#each paginatedVariants as v (v.id)}
              <tr class="border-b last:border-0 hover:bg-muted/20">
                <td class="px-4 py-2">
                  <span class="font-medium">
                    {v.product.publicDisplayName}{v.label ? ` - ${v.label}` : ''}
                  </span>
                </td>
                <td class="px-4 py-2 text-muted-foreground">
                  {v.sku}
                </td>
                <td class="px-4 py-2">
                  <Combobox
                    options={groupOptions}
                    value={getGroupId(v.id, v.interchangeGroupId)}
                    onChange={(val) => {
                      if (val !== getGroupId(v.id, v.interchangeGroupId)) {
                        updateGroup(v.id, val);
                      }
                    }}
                    placeholder="— None —"
                    disabled={busy}
                  />
                </td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
    <div class="flex items-center justify-between">
      <p class="text-sm text-muted-foreground">
        {variants.length} variant{variants.length === 1 ? "" : "s"}
      </p>
      <Pagination bind:page={pageNumber} {pageSize} totalItems={variants.length} />
    </div>
  {/if}
</div>
