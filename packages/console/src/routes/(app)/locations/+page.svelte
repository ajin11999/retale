<script lang="ts">
  import NumericInput from "$lib/components/ui/numeric-input.svelte";
  import { CachePolicy, graphql } from "$houdini";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { Archive, ArchiveRestore, Boxes, Pencil, Trash2 } from "@lucide/svelte";
  import IconButton from "$lib/components/ui/icon-button.svelte";
  import type { Viewer } from "../+layout.server";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Combobox from "$lib/components/ui/combobox.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import Pagination from "$lib/components/ui/pagination.svelte";
  import Textarea from "$lib/components/ui/textarea.svelte";
  import { matchesTokens, searchTokens } from "$lib/utils";
  import type { PageData } from "./$types";

  // Query document — Houdini scans this for codegen. The live store is
  // supplied by +page.ts through `data` (route-store wiring is unavailable).
  graphql(`
    query LocationList {
      locations(includeArchived: true) {
        id
        name
        parentId
        code
        notes
        sortOrder
        archivedAt
      }
    }
  `);

  const CreateLocation = graphql(`
    mutation ConsoleCreateLocation(
      $name: String!
      $parentId: ID
      $code: String
      $notes: String
      $sortOrder: Int
    ) {
      createLocation(
        name: $name
        parentId: $parentId
        code: $code
        notes: $notes
        sortOrder: $sortOrder
      ) {
        id
      }
    }
  `);

  const UpdateLocation = graphql(`
    mutation ConsoleUpdateLocation(
      $id: ID!
      $name: String
      $parentId: ID
      $code: String
      $notes: String
      $sortOrder: Int
    ) {
      updateLocation(
        id: $id
        name: $name
        parentId: $parentId
        code: $code
        notes: $notes
        sortOrder: $sortOrder
      ) {
        id
        name
        parentId
        code
        notes
        sortOrder
      }
    }
  `);

  const SetLocationArchived = graphql(`
    mutation ConsoleSetLocationArchived($id: ID!, $archived: Boolean!) {
      setLocationArchived(id: $id, archived: $archived) {
        id
        archivedAt
      }
    }
  `);

  const HardDeleteLocation = graphql(`
    mutation ConsoleHardDeleteLocation($id: ID!) {
      hardDeleteLocation(id: $id)
    }
  `);

  let { data }: { data: PageData } = $props();
  const LocationList = $derived(data.LocationList);
  const locations = $derived($LocationList.data?.locations ?? []);

  // ---- Viewer permissions --------------------------------------------------
  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canCreate = $derived(has("location.create"));
  const canEdit = $derived(has("location.edit"));
  const canArchive = $derived(has("location.archive"));
  const canHardDelete = $derived(has("location.hard_delete"));
  const canViewStock = $derived(has("stock.adjust"));

  // ---- Hierarchy ordering --------------------------------------------------
  // Flatten the self-referential forest into a depth-tagged, parent-before-
  // child list so the table can indent rows.
  interface Node {
    id: string;
    name: string;
    parentId: string | null;
    code: string | null;
    notes: string | null;
    sortOrder: number;
    archived: boolean;
    depth: number;
  }

  const tree = $derived.by<Node[]>(() => {
    const children = new Map<string | null, typeof locations>();
    for (const l of locations) {
      const key = l.parentId ?? null;
      const list = children.get(key) ?? [];
      list.push(l);
      children.set(key, list);
    }
    for (const list of children.values()) {
      list.sort(
        (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
      );
    }
    const out: Node[] = [];
    const walk = (parentId: string | null, depth: number) => {
      for (const l of children.get(parentId) ?? []) {
        out.push({
          id: l.id,
          name: l.name,
          parentId: l.parentId ?? null,
          code: l.code ?? null,
          notes: l.notes ?? null,
          sortOrder: l.sortOrder,
          archived: l.archivedAt != null,
          depth,
        });
        walk(l.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  });

  // ---- Search --------------------------------------------------------------
  // Match by name or code; keep each match's ancestors so the tree still reads.
  let search = $state("");
  const visibleTree = $derived.by<Node[]>(() => {
    const tokens = searchTokens(search.trim());
    if (!tokens.length) return tree;
    const byId = new Map(tree.map((n) => [n.id, n]));
    const visible = new Set<string>();
    for (const n of tree) {
      if (!matchesTokens(tokens, n.name, n.code)) continue;
      let cur: Node | undefined = n;
      while (cur && !visible.has(cur.id)) {
        visible.add(cur.id);
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
    }
    return tree.filter((n) => visible.has(n.id));
  });

  let pageNumber = $state(1);
  const pageSize = 50;
  $effect(() => {
    search;
    pageNumber = 1;
  });
  const paginatedTree = $derived(visibleTree.slice((pageNumber - 1) * pageSize, pageNumber * pageSize));

  // ---- Editor --------------------------------------------------------------
  interface LocationDraft {
    id: string | null; // null → a new location
    name: string;
    parentId: string;
    code: string;
    notes: string;
    sortOrder: number;
  }

  let draft = $state<LocationDraft | null>(null);
  let busy = $state(false);
  let feedback = $state<{ ok: boolean; text: string } | null>(null);

  // Parent options for a draft — a location cannot be its own descendant.
  const parentOptions = $derived.by(() => {
    if (!draft || !draft.id) return tree;
    const id = draft.id;
    const banned = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of tree) {
        if (n.parentId && banned.has(n.parentId) && !banned.has(n.id)) {
          banned.add(n.id);
          grew = true;
        }
      }
    }
    return tree.filter((n) => !banned.has(n.id));
  });

  // Full ancestry path per node ("Warehouse › Aisle 3 › Bin A"), so the parent
  // Combobox shows hierarchy context in a flat, searchable list. `tree` is
  // parent-before-child, so each node's parent path is already computed.
  const pathById = $derived.by(() => {
    const m = new Map<string, string>();
    for (const n of tree) {
      const parentPath = n.parentId ? m.get(n.parentId) : undefined;
      m.set(n.id, parentPath ? `${parentPath} › ${n.name}` : n.name);
    }
    return m;
  });

  // { value, label } parent options: a leading "Top level" row, then each
  // allowed parent (descendants of the edited node are excluded) by full path.
  const parentComboOptions = $derived([
    { value: "", label: "— Top level —" },
    ...parentOptions.map((n) => ({
      value: n.id,
      label: pathById.get(n.id) ?? n.name,
    })),
  ]);

  function newLocation() {
    draft = {
      id: null,
      name: "",
      parentId: "",
      code: "",
      notes: "",
      sortOrder: 0,
    };
  }

  function editLocation(n: Node) {
    draft = {
      id: n.id,
      name: n.name,
      parentId: n.parentId ?? "",
      code: n.code ?? "",
      notes: n.notes ?? "",
      sortOrder: n.sortOrder,
    };
  }

  /** Run a mutation, surfacing the first GraphQL error as feedback. */
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

  async function saveLocation() {
    const d = draft;
    if (!d || !d.name.trim()) return;
    const ok = await run("Location", () =>
      d.id
        ? UpdateLocation.mutate({
            id: d.id,
            name: d.name.trim(),
            parentId: d.parentId || null,
            code: d.code.trim() || null,
            notes: d.notes.trim() || null,
            sortOrder: d.sortOrder,
          })
        : CreateLocation.mutate({
            name: d.name.trim(),
            parentId: d.parentId || null,
            code: d.code.trim() || null,
            notes: d.notes.trim() || null,
            sortOrder: d.sortOrder,
          }),
    );
    if (ok) {
      draft = null;
      await LocationList.fetch({ policy: CachePolicy.NetworkOnly });
    }
  }

  async function toggleArchived(n: Node) {
    const ok = await run("Location", () =>
      SetLocationArchived.mutate({ id: n.id, archived: !n.archived }),
    );
    if (ok) await LocationList.fetch({ policy: CachePolicy.NetworkOnly });
  }

  async function hardDelete(n: Node) {
    if (
      !confirm(
        `Permanently delete "${n.name}"? Refused by the API if it has child ` +
          `locations or holds stock.`,
      )
    )
      return;
    const ok = await run("Location", () =>
      HardDeleteLocation.mutate({ id: n.id }),
    );
    if (ok) {
      if (draft?.id === n.id) draft = null;
      await LocationList.fetch({ policy: CachePolicy.NetworkOnly });
    }
  }
</script>

<svelte:head><title>Locations · Retale Console</title></svelte:head>

<div class="space-y-4">
  <div class="flex items-center justify-between gap-3">
    <h1 class="text-xl font-semibold">Locations</h1>
    <div class="flex items-center gap-2">
      <div class="w-64">
        <Input
          type="search"
          placeholder="Search locations…"
          bind:value={search}
        />
      </div>
      <Button size="sm" disabled={busy || !canCreate} onclick={newLocation}>
        New location
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
      You have read-only access to locations — editing is disabled.
    </p>
  {/if}

  {#if draft}
    <div class="space-y-3 rounded-lg border bg-card p-5">
      <h2 class="text-sm font-semibold">
        {draft.id ? "Edit location" : "New location"}
      </h2>
      <div class="grid grid-cols-2 gap-4">
        <label class="space-y-1">
          <span class="text-sm font-medium">Name</span>
          <Input bind:value={draft.name} disabled={!canEdit} />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Parent</span>
          <Combobox
            options={parentComboOptions}
            bind:value={draft.parentId}
            placeholder="Search parent location…"
            disabled={!canEdit}
          />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Code</span>
          <Input bind:value={draft.code} disabled={!canEdit} />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Sort order</span>
          <NumericInput
            bind:value={draft.sortOrder}
            disabled={!canEdit}
          />
        </label>
      </div>
      <label class="space-y-1">
        <span class="text-sm font-medium">Notes</span>
        <Textarea
          bind:value={draft.notes}
          disabled={!canEdit}
          class="h-20 resize-none"
        />
      </label>
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
          onclick={saveLocation}
        >
          {draft.id ? "Save location" : "Create location"}
        </Button>
      </div>
    </div>
  {/if}

  {#if $LocationList.fetching && locations.length === 0}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if $LocationList.errors?.length}
    <p class="text-sm text-destructive">{$LocationList.errors[0].message}</p>
  {:else}
    <div class="overflow-hidden rounded-lg border bg-card">
      <table class="w-full text-sm">
        <thead class="border-b bg-muted/50 text-left text-muted-foreground">
          <tr>
            <th class="px-4 py-2 font-medium">Location</th>
            <th class="px-4 py-2 font-medium">Code</th>
            <th class="px-4 py-2 font-medium">Status</th>
            <th class="px-4 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {#each paginatedTree as n (n.id)}
            <tr class="border-b last:border-0 hover:bg-muted/40">
              <td class="px-4 py-2">
                <span style:padding-left={`${n.depth * 1.25}rem`}>
                  {n.depth > 0 ? "└ " : ""}<span class="font-medium"
                    >{n.name}</span
                  >
                </span>
              </td>
              <td class="px-4 py-2 font-mono text-xs text-muted-foreground">
                {n.code ?? "—"}
              </td>
              <td class="px-4 py-2">
                <Badge
                  class={n.archived
                    ? "bg-muted text-muted-foreground"
                    : "bg-emerald-100 text-emerald-700"}
                >
                  {n.archived ? "Archived" : "Active"}
                </Badge>
              </td>
              <td class="px-4 py-2 text-right whitespace-nowrap">
                <span class="inline-flex items-center gap-0.5">
                  {#if canViewStock}
                    <IconButton
                      icon={Boxes}
                      label="Stock"
                      disabled={busy}
                      onclick={() => goto(`/stock?location=${n.id}`)}
                    />
                  {/if}
                  <IconButton
                    icon={Pencil}
                    label="Edit"
                    variant="primary"
                    disabled={busy || !canEdit}
                    onclick={() => editLocation(n)}
                  />
                  <IconButton
                    icon={n.archived ? ArchiveRestore : Archive}
                    label={n.archived ? "Restore" : "Archive"}
                    disabled={busy || !canArchive}
                    onclick={() => toggleArchived(n)}
                  />
                  {#if canHardDelete}
                    <IconButton
                      icon={Trash2}
                      label="Delete"
                      variant="destructive"
                      disabled={busy}
                      onclick={() => hardDelete(n)}
                    />
                  {/if}
                </span>
              </td>
            </tr>
          {/each}
          {#if visibleTree.length === 0}
            <tr>
              <td colspan="4" class="px-4 py-10 text-center text-muted-foreground">
                {search.trim() ? "No locations match." : "No locations yet."}
              </td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>
    <div class="mt-2 flex items-center justify-between">
      <p class="text-sm text-muted-foreground">
        {visibleTree.length} location{visibleTree.length === 1 ? "" : "s"}
      </p>
      <Pagination bind:page={pageNumber} {pageSize} totalItems={visibleTree.length} />
    </div>
  {/if}
</div>
