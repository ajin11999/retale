<script lang="ts">
  import { CachePolicy, graphql } from "$houdini";
  import { page } from "$app/state";
  import { Archive, ArchiveRestore, Pencil, Trash2 } from "@lucide/svelte";
  import type { Viewer } from "../+layout.server";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import IconButton from "$lib/components/ui/icon-button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import Select from "$lib/components/ui/select.svelte";
  import type { PageData } from "./$types";

  // Query document — Houdini scans this for codegen. The live store is
  // supplied by +page.ts through `data` (route-store wiring is unavailable).
  graphql(`
    query CategoryList {
      categories {
        id
        name
        parentId
        minQty
        minMarginBps
        archivedAt
      }
      products(includeArchived: true) {
        id
        categoryId
      }
    }
  `);

  const CreateCategory = graphql(`
    mutation ConsoleCreateCategory(
      $name: String!
      $parentId: ID
      $minQty: Int
      $minMarginBps: Int
    ) {
      createCategory(
        name: $name
        parentId: $parentId
        minQty: $minQty
        minMarginBps: $minMarginBps
      ) {
        id
      }
    }
  `);

  const UpdateCategory = graphql(`
    mutation ConsoleUpdateCategory(
      $id: ID!
      $name: String
      $parentId: ID
      $minQty: Int
      $minMarginBps: Int
    ) {
      updateCategory(
        id: $id
        name: $name
        parentId: $parentId
        minQty: $minQty
        minMarginBps: $minMarginBps
      ) {
        id
        name
        parentId
        minQty
        minMarginBps
      }
    }
  `);

  const SetCategoryArchived = graphql(`
    mutation ConsoleSetCategoryArchived($id: ID!, $archived: Boolean!) {
      setCategoryArchived(id: $id, archived: $archived) {
        id
        archivedAt
      }
    }
  `);

  const DeleteCategory = graphql(`
    mutation ConsoleDeleteCategory($id: ID!) {
      deleteCategory(id: $id)
    }
  `);

  let { data }: { data: PageData } = $props();
  const CategoryList = $derived(data.CategoryList);

  const categories = $derived($CategoryList.data?.categories ?? []);
  const products = $derived($CategoryList.data?.products ?? []);

  // Direct product count per category (not rolled up into children).
  const productCount = $derived.by(() => {
    const m = new Map<string, number>();
    for (const p of products) {
      if (p.categoryId) m.set(p.categoryId, (m.get(p.categoryId) ?? 0) + 1);
    }
    return m;
  });

  // ---- Viewer permissions --------------------------------------------------
  // Mirrors the API: createCategory needs product.create, update/delete need
  // product.edit, archive needs product.archive.
  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canCreate = $derived(has("product.create"));
  const canEdit = $derived(has("product.edit"));
  const canArchive = $derived(has("product.archive"));

  // ---- Hierarchy ordering --------------------------------------------------
  // Flatten the self-referential tree into a depth-tagged, parent-before-child
  // list so the table can indent rows.
  interface Node {
    id: string;
    name: string;
    parentId: string | null;
    minQty: number | null;
    minMarginBps: number | null;
    archived: boolean;
    depth: number;
  }

  const tree = $derived.by<Node[]>(() => {
    const children = new Map<string | null, typeof categories>();
    for (const c of categories) {
      const key = c.parentId ?? null;
      const list = children.get(key) ?? [];
      list.push(c);
      children.set(key, list);
    }
    for (const list of children.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    const out: Node[] = [];
    const walk = (parentId: string | null, depth: number) => {
      for (const c of children.get(parentId) ?? []) {
        out.push({
          id: c.id,
          name: c.name,
          parentId: c.parentId ?? null,
          minQty: c.minQty ?? null,
          minMarginBps: c.minMarginBps ?? null,
          archived: c.archivedAt != null,
          depth,
        });
        walk(c.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  });

  // ---- Search --------------------------------------------------------------
  // Match by name; keep each match's ancestors so the hierarchy still reads.
  let search = $state("");
  const visibleTree = $derived.by<Node[]>(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tree;
    const byId = new Map(tree.map((n) => [n.id, n]));
    const visible = new Set<string>();
    for (const n of tree) {
      if (!n.name.toLowerCase().includes(q)) continue;
      let cur: Node | undefined = n;
      while (cur && !visible.has(cur.id)) {
        visible.add(cur.id);
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
    }
    return tree.filter((n) => visible.has(n.id));
  });

  // ---- Editor --------------------------------------------------------------
  interface CategoryDraft {
    id: string | null; // null → a new category
    name: string;
    parentId: string;
    minQty: number | null;
    minMarginBps: number | null;
  }

  let draft = $state<CategoryDraft | null>(null);
  let busy = $state(false);
  let feedback = $state<{ ok: boolean; text: string } | null>(null);

  // Parent options for a draft — a category cannot be its own descendant.
  const parentOptions = $derived.by(() => {
    if (!draft) return tree;
    const id = draft.id;
    if (!id) return tree;
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

  function newCategory() {
    draft = {
      id: null,
      name: "",
      parentId: "",
      minQty: null,
      minMarginBps: null,
    };
  }

  function editCategory(n: Node) {
    draft = {
      id: n.id,
      name: n.name,
      parentId: n.parentId ?? "",
      minQty: n.minQty,
      minMarginBps: n.minMarginBps,
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

  async function saveCategory() {
    const d = draft;
    if (!d || !d.name.trim()) return;
    const ok = await run("Category", () =>
      d.id
        ? UpdateCategory.mutate({
            id: d.id,
            name: d.name.trim(),
            parentId: d.parentId || null,
            minQty: d.minQty,
            minMarginBps: d.minMarginBps,
          })
        : CreateCategory.mutate({
            name: d.name.trim(),
            parentId: d.parentId || null,
            minQty: d.minQty,
            minMarginBps: d.minMarginBps,
          }),
    );
    if (ok) {
      draft = null;
      await CategoryList.fetch({ policy: CachePolicy.NetworkOnly });
    }
  }

  async function toggleArchived(n: Node) {
    const ok = await run("Category", () =>
      SetCategoryArchived.mutate({ id: n.id, archived: !n.archived }),
    );
    if (ok) await CategoryList.fetch({ policy: CachePolicy.NetworkOnly });
  }

  async function deleteCategory(n: Node) {
    if (
      !confirm(
        `Delete "${n.name}"? Its products become uncategorized and child ` +
          `categories are reparented.`,
      )
    )
      return;
    const ok = await run("Category", () => DeleteCategory.mutate({ id: n.id }));
    if (ok) {
      if (draft?.id === n.id) draft = null;
      await CategoryList.fetch({ policy: CachePolicy.NetworkOnly });
    }
  }
</script>

<svelte:head><title>Categories · Retale Console</title></svelte:head>

<div class="space-y-4">
  <div class="flex items-center justify-between gap-3">
    <h1 class="text-xl font-semibold">Categories</h1>
    <div class="flex items-center gap-2">
      <div class="w-64">
        <Input
          type="search"
          placeholder="Search categories…"
          bind:value={search}
        />
      </div>
      <Button size="sm" disabled={busy || !canCreate} onclick={newCategory}>
        New category
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
        {draft.id ? "Edit category" : "New category"}
      </h2>
      <div class="grid grid-cols-2 gap-4">
        <label class="space-y-1">
          <span class="text-sm font-medium">Name</span>
          <Input bind:value={draft.name} disabled={!canEdit} />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Parent</span>
          <Select bind:value={draft.parentId} disabled={!canEdit}>
            <option value="">— Top level —</option>
            {#each parentOptions as p (p.id)}
              <option value={p.id}>
                {"— ".repeat(p.depth)}{p.name}
              </option>
            {/each}
          </Select>
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Min qty</span>
          <Input
            type="number"
            bind:value={draft.minQty}
            placeholder="Inherited / none"
            disabled={!canEdit}
          />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Min margin (basis points)</span>
          <Input
            type="number"
            bind:value={draft.minMarginBps}
            placeholder="Inherited / none"
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
          onclick={saveCategory}
        >
          {draft.id ? "Save category" : "Create category"}
        </Button>
      </div>
    </div>
  {/if}

  {#if $CategoryList.fetching && categories.length === 0}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if $CategoryList.errors?.length}
    <p class="text-sm text-destructive">{$CategoryList.errors[0].message}</p>
  {:else}
    <div class="overflow-hidden rounded-lg border bg-card">
      <table class="w-full text-sm">
        <thead class="border-b bg-muted/50 text-left text-muted-foreground">
          <tr>
            <th class="px-4 py-2 font-medium">Category</th>
            <th class="px-4 py-2 text-right font-medium">Products</th>
            <th class="px-4 py-2 text-right font-medium">Min qty</th>
            <th class="px-4 py-2 text-right font-medium">Min margin (bps)</th>
            <th class="px-4 py-2 font-medium">Status</th>
            <th class="px-4 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {#each visibleTree as n (n.id)}
            <tr class="border-b last:border-0 hover:bg-muted/40">
              <td class="px-4 py-2">
                <span style:padding-left={`${n.depth * 1.25}rem`}>
                  {n.depth > 0 ? "└ " : ""}<span class="font-medium"
                    >{n.name}</span
                  >
                </span>
              </td>
              <td class="px-4 py-2 text-right">
                {#if (productCount.get(n.id) ?? 0) > 0}
                  <a
                    href={`/products?category=${n.id}`}
                    class="text-primary hover:underline"
                    title={`View products in ${n.name}`}
                    >{productCount.get(n.id)}</a
                  >
                {:else}
                  0
                {/if}
              </td>
              <td class="px-4 py-2 text-right">{n.minQty ?? "—"}</td>
              <td class="px-4 py-2 text-right">{n.minMarginBps ?? "—"}</td>
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
                  <IconButton
                    icon={Pencil}
                    label="Edit"
                    variant="primary"
                    disabled={busy || !canEdit}
                    onclick={() => editCategory(n)}
                  />
                  <IconButton
                    icon={n.archived ? ArchiveRestore : Archive}
                    label={n.archived ? "Restore" : "Archive"}
                    disabled={busy || !canArchive}
                    onclick={() => toggleArchived(n)}
                  />
                  <IconButton
                    icon={Trash2}
                    label="Delete"
                    variant="destructive"
                    disabled={busy || !canEdit}
                    onclick={() => deleteCategory(n)}
                  />
                </span>
              </td>
            </tr>
          {/each}
          {#if visibleTree.length === 0}
            <tr>
              <td colspan="6" class="px-4 py-10 text-center text-muted-foreground">
                {search.trim() ? "No categories match." : "No categories yet."}
              </td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>
  {/if}
</div>
