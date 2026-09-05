<script lang="ts">
  import NumericInput from "$lib/components/ui/numeric-input.svelte";
  import { CachePolicy, graphql } from "$houdini";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { Archive, ArchiveRestore, Check, Pencil, Trash2, X, List, Star } from "@lucide/svelte";
  import type { Viewer } from "../+layout.server";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import DuplicateHint from "$lib/components/ui/duplicate-hint.svelte";
  import IconButton from "$lib/components/ui/icon-button.svelte";
  import Combobox from "$lib/components/ui/combobox.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import Pagination from "$lib/components/ui/pagination.svelte";
  import { matchesTokens, searchTokens } from "$lib/utils";
  import { SvelteSet } from "svelte/reactivity";
  import { t } from "$lib/i18n";
  import type { PageData } from "./$types";

  graphql(`
    query InterchangeGroupList {
      interchangeGroups {
        id
        name
        minQty
        preferredVariantId
        archivedAt
        variants {
          id
          sku
          label
          product {
            id
            publicDisplayName
          }
        }
      }
    }
  `);

  const SearchVariantsQuery = graphql(`
    query ConsoleSearchVariants($search: String!) {
      searchVariants(search: $search, limit: 50) {
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

  let pageNumber = $state(1);
  const pageSize = 50;
  $effect(() => {
    search;
    pageNumber = 1;
  });
  const paginatedGroups = $derived(visibleGroups.slice((pageNumber - 1) * pageSize, pageNumber * pageSize));

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
    const options = [{ value: "", label: t("interchangeGroups.none") }];
    const d = draft;
    if (!d?.id) return options;
    const group = interchangeGroups.find((g) => g.id === d.id);
    if (!group) return options;
    for (const v of group.variants) {
      const name = `${v.product.publicDisplayName}${v.label ? ` - ${v.label}` : ''}`;
      options.push({
        value: v.id,
        label: `${name} (${v.sku})`
      });
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
      note: c.archivedAt ? t("common.archived") : null,
    })),
  );

  function editGroupById(id: string) {
    const n = interchangeGroups.find((t) => t.id === id);
    if (n) editGroup(n);
  }

  async function run(
    message: string,
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
      feedback = { ok: true, text: message };
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
    const ok = await run(t("common.saved", { label: t("interchangeGroups.group") }), () =>
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
    const ok = await run(t("common.saved", { label: t("interchangeGroups.group") }), () =>
      SetInterchangeGroupArchived.mutate({ id: n.id, archived: !n.archivedAt }),
    );
    if (ok) await InterchangeGroupList.fetch({ policy: CachePolicy.NetworkOnly });
  }

  async function deleteGroup(n: typeof interchangeGroups[0]) {
    if (!confirm(t("interchangeGroups.confirmDelete", { name: n.name }))) return;
    const ok = await run(t("common.saved", { label: t("interchangeGroups.group") }), () => DeleteInterchangeGroup.mutate({ id: n.id }));
    if (ok) {
      if (draft?.id === n.id) draft = null;
      await InterchangeGroupList.fetch({ policy: CachePolicy.NetworkOnly });
    }
  }

  // --- Variant Management ---
  let managingGroup = $state<typeof interchangeGroups[0] | null>(null);
  let variantSearch = $state("");
  let selectedVariantIds = $state(new SvelteSet<string>());

  // Houdini requires manual fetch for dynamic search
  import { ConsoleSearchVariantsStore } from "$houdini";
  const searchVariantsStore = new ConsoleSearchVariantsStore();

  $effect(() => {
    if (managingGroup) {
      searchVariantsStore.fetch({
        variables: { search: variantSearch.trim() },
        policy: CachePolicy.NetworkOnly
      });
    }
  });

  const availableVariants = $derived($searchVariantsStore.data?.searchVariants ?? []);
  const filteredAvailableVariants = $derived.by(() => {
    const mg = managingGroup;
    if (!mg) return [];
    return availableVariants
      .filter((v) => v.interchangeGroupId !== mg.id)
      .map((v) => {
        const name = `${v.product.publicDisplayName}${v.label ? ` - ${v.label}` : ''}`;
        return { id: v.id, name, sku: v.sku };
      });
  });

  const groupVariants = $derived.by(() => {
    const mg = managingGroup;
    if (!mg) return [];
    const group = interchangeGroups.find((g) => g.id === mg.id);
    if (!group) return [];
    return group.variants.map((v) => {
      const name = `${v.product.publicDisplayName}${v.label ? ` - ${v.label}` : ''}`;
      return { id: v.id, name, sku: v.sku, isPreferred: v.id === group.preferredVariantId };
    });
  });

  function manageVariants(n: typeof interchangeGroups[0]) {
    managingGroup = n;
    variantSearch = "";
    selectedVariantIds = new SvelteSet();
  }

  async function addSelectedVariants() {
    if (!managingGroup || selectedVariantIds.size === 0) return;
    const ok = await run(t("interchangeGroups.variantsAssigned"), () =>
      SetVariantsInterchangeGroup.mutate({
        groupId: managingGroup!.id,
        variantIds: Array.from(selectedVariantIds),
      })
    );
    if (ok) {
      selectedVariantIds = new SvelteSet();
      await InterchangeGroupList.fetch({ policy: CachePolicy.NetworkOnly });
    }
  }

  async function removeVariant(variantId: string) {
    if (!confirm(t("interchangeGroups.confirmRemoveVariant"))) return;
    const ok = await run(t("interchangeGroups.variantRemoved"), () =>
      SetVariantsInterchangeGroup.mutate({
        groupId: null,
        variantIds: [variantId],
      })
    );
    if (ok) {
      await InterchangeGroupList.fetch({ policy: CachePolicy.NetworkOnly });
    }
  }

  async function setPreferredVariant(variantId: string) {
    if (!managingGroup) return;
    const ok = await run(t("interchangeGroups.preferredUpdated"), () =>
      UpdateInterchangeGroup.mutate({
        id: managingGroup!.id,
        preferredVariantId: variantId,
      })
    );
    if (ok) {
      await InterchangeGroupList.fetch({ policy: CachePolicy.NetworkOnly });
    }
  }
</script>

<svelte:head><title>{t("interchangeGroups.pageTitle")}</title></svelte:head>

<div class="space-y-4">
  <div class="flex items-center justify-between gap-3">
    <h1 class="text-xl font-semibold">{t("interchangeGroups.title")}</h1>
    <div class="flex items-center gap-2">
      <div class="w-64">
        <Input
          type="search"
          placeholder={t("interchangeGroups.searchGroups")}
          bind:value={search}
        />
      </div>
      <Button variant="outline" size="sm" disabled={busy || !canCreate} onclick={() => goto("/interchange-groups/bulk")}>
        {t("interchangeGroups.bulkAdd")}
      </Button>
      <Button variant="outline" size="sm" disabled={busy || !canEdit} onclick={() => goto("/interchange-groups/variants")}>
        {t("interchangeGroups.manageVariants")}
      </Button>
      <Button size="sm" disabled={busy || !canCreate} onclick={newGroup}>
        {t("interchangeGroups.newGroup")}
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
      {t("categories.readOnlyNotice")}
    </p>
  {/if}

  {#if draft}
    <div class="space-y-3 rounded-lg border bg-card p-5">
      <h2 class="text-sm font-semibold">
        {draft.id ? t("interchangeGroups.editGroup") : t("interchangeGroups.newGroup")}
      </h2>
      <div class="grid grid-cols-2 gap-4">
        <label class="relative space-y-1">
          <span class="text-sm font-medium">{t("common.name")}</span>
          <Input bind:value={draft.name} disabled={!canEdit} />
          <DuplicateHint
            query={draft.name}
            items={groupCandidates}
            excludeId={draft.id}
            noun="group"
          />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">{t("products.minQty")}</span>
          <NumericInput
            bind:value={draft.minQty}
            placeholder={t("interchangeGroups.none")}
            disabled={!canEdit}
          />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">{t("interchangeGroups.preferredVariant")}</span>
          <Combobox
            options={variantComboOptions}
            bind:value={draft.preferredVariantId}
            placeholder={t("products.searchProducts")}
            disabled={!canEdit}
          />
        </label>
      </div>
      <div class="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onclick={() => (draft = null)}>{t("common.cancel")}</Button
        >
        <Button
          size="sm"
          disabled={busy || !canEdit || !draft.name.trim()}
          onclick={saveGroup}
        >
          {draft.id ? t("interchangeGroups.saveGroup") : t("interchangeGroups.createGroup")}
        </Button>
      </div>
    </div>
  {/if}

  {#if managingGroup}
    <div class="space-y-4 rounded-lg border bg-card p-5">
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold">
          {t("interchangeGroups.manageVariants")}: {managingGroup.name}
        </h2>
        <Button variant="ghost" size="sm" onclick={() => (managingGroup = null)}>{t("common.close")}</Button>
      </div>

      <div class="grid md:grid-cols-2 gap-6">
        <div class="space-y-3">
          <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t("interchangeGroups.currentVariants")}</h3>
          {#if groupVariants.length === 0}
            <p class="text-sm text-muted-foreground">{t("interchangeGroups.noVariantsAssigned")}</p>
          {:else}
            <div class="space-y-2">
              {#each groupVariants as v}
                <div class="flex items-center justify-between gap-2 p-2 rounded border bg-muted/20">
                  <div class="flex flex-col">
                    <span class="text-sm font-medium">{v.name}</span>
                    <span class="text-xs font-mono text-muted-foreground">{v.sku}</span>
                    {#if v.isPreferred}
                      <span class="text-[10px] text-emerald-600 font-semibold uppercase mt-0.5">{t("interchangeGroups.preferred")}</span>
                    {/if}
                  </div>
                  <div class="flex items-center gap-1">
                    {#if !v.isPreferred}
                      <IconButton
                        icon={Star}
                        label={t("interchangeGroups.setAsPreferred")}
                        variant="muted"
                        disabled={busy || !canEdit}
                        onclick={() => setPreferredVariant(v.id)}
                      />
                    {/if}
                    <IconButton
                      icon={X}
                      label={t("interchangeGroups.removeFromGroup")}
                      variant="muted"
                      disabled={busy || !canEdit}
                      onclick={() => removeVariant(v.id)}
                    />
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>

        <div class="space-y-3">
          <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t("interchangeGroups.addVariants")}</h3>
          <div class="flex gap-2">
            <Input 
              placeholder={t("requisitions.searchVariant")} 
              bind:value={variantSearch}
              class="flex-1"
            />
            <Button 
              size="sm" 
              disabled={busy || !canEdit || selectedVariantIds.size === 0} 
              onclick={addSelectedVariants}
            >
              {t("interchangeGroups.addSelected", { count: selectedVariantIds.size })}
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
                  <span class="text-xs font-mono text-muted-foreground">{v.sku}</span>
                </div>
              </label>
            {:else}
              <div class="p-4 text-center text-sm text-muted-foreground">
                {variantSearch.trim() ? t("interchangeGroups.noMatchingVariants") : t("interchangeGroups.typeToSearch")}
              </div>
            {/each}
          </div>
        </div>
      </div>
    </div>
  {/if}

  {#if $InterchangeGroupList.fetching && interchangeGroups.length === 0}
    <p class="text-sm text-muted-foreground">{t("common.loading")}</p>
  {:else if $InterchangeGroupList.errors?.length}
    <p class="text-sm text-destructive">{$InterchangeGroupList.errors[0].message}</p>
  {:else}
    <div class="overflow-hidden rounded-lg border bg-card">
      <table class="w-full text-sm">
        <thead class="border-b bg-muted/50 text-left text-muted-foreground">
          <tr>
            <th class="px-4 py-2 font-medium">{t("interchangeGroups.group")}</th>
            <th class="px-4 py-2 text-right font-medium">{t("products.minQty")}</th>
            <th class="px-4 py-2 font-medium">{t("common.status")}</th>
            <th class="px-4 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {#each paginatedGroups as n (n.id)}
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
                  {n.archivedAt != null ? t("common.archived") : t("common.active")}
                </Badge>
              </td>
              <td class="px-4 py-2 text-right whitespace-nowrap">
                <span class="inline-flex items-center gap-0.5">
                  <IconButton
                    icon={List}
                    label={t("interchangeGroups.manageVariants")}
                    variant="primary"
                    disabled={busy || !canEdit}
                    onclick={() => manageVariants(n)}
                  />
                  <IconButton
                    icon={Pencil}
                    label={t("common.edit")}
                    variant="primary"
                    disabled={busy || !canEdit}
                    onclick={() => editGroup(n)}
                  />
                  <IconButton
                    icon={n.archivedAt != null ? ArchiveRestore : Archive}
                    label={n.archivedAt != null ? t("addresses.restore") : t("addresses.archive")}
                    disabled={busy || !canArchive}
                    onclick={() => toggleArchived(n)}
                  />
                  <IconButton
                    icon={Trash2}
                    label={t("common.delete")}
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
                {search.trim() ? t("interchangeGroups.noMatch") : t("interchangeGroups.noGroups")}
              </td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>
    <div class="mt-2 flex items-center justify-between">
      <p class="text-sm text-muted-foreground">
        {t("interchangeGroups.groupCount", { count: visibleGroups.length })}
      </p>
      <Pagination bind:page={pageNumber} {pageSize} totalItems={visibleGroups.length} />
    </div>
  {/if}
</div>
