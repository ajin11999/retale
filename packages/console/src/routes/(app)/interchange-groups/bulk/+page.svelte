<script lang="ts">
  import { graphql } from "$houdini";
  import { page } from "$app/state";
  import { Check, X } from "@lucide/svelte";
  import type { Viewer } from "../../+layout.server";
  import Button from "$lib/components/ui/button.svelte";
  import IconButton from "$lib/components/ui/icon-button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import NumericInput from "$lib/components/ui/numeric-input.svelte";
  import Combobox from "$lib/components/ui/combobox.svelte";
  import type { PageData } from "./$types";

  // Reuses the ordinary createInterchangeGroup mutation, one call per row. Own document
  // name so Houdini doesn't collide with the list page's ConsoleCreateInterchangeGroup.
  const BulkCreateGroup = graphql(`
    mutation ConsoleBulkCreateInterchangeGroup(
      $name: String!
      $minQty: Int
    ) {
      createInterchangeGroup(
        name: $name
        minQty: $minQty
      ) {
        id
        name
      }
    }
  `);

  graphql(`
    query InterchangeGroupsBulkAdd {
      interchangeGroups {
        id
        name
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const BulkAdd = $derived(data.InterchangeGroupsBulkAdd);

  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canCreate = $derived(has("product.create"));

  // ---- Ephemeral draft rows ------------------------------------------------
  // These live only in page state — a refresh discards them by design. Each row
  // becomes one group on submit.
  interface BulkRow {
    name: string;
    minQty: number | null;
    status: "idle" | "saving" | "created" | "error";
    error?: string;
    createdId?: string;
  }
  const blankRow = (): BulkRow => ({
    name: "",
    minQty: null,
    status: "idle",
  });
  const rowEmpty = (r: BulkRow) =>
    !r.name.trim() && r.minQty == null;

  let rows = $state<BulkRow[]>([blankRow()]);
  let busy = $state(false);
  let summary = $state<{ created: number; failed: number } | null>(null);

  const existingGroups = $derived($BulkAdd.data?.interchangeGroups ?? []);
  const customNames = $derived(
    Array.from(new Set(rows.map((r) => r.name.trim()).filter(Boolean))),
  );
  const groupOptions = $derived([
    ...existingGroups.map((g) => ({ value: g.name, label: g.name })),
    ...customNames
      .filter((n) => !existingGroups.some((g) => g.name === n))
      .map((n) => ({ value: n, label: n })),
  ]);

  // Keep exactly one trailing blank row, so the grid grows as you type — the
  // spreadsheet "keep going" feel without a manual "add row" click.
  $effect(() => {
    const last = rows[rows.length - 1];
    if (!last || !rowEmpty(last)) rows.push(blankRow());
  });

  function removeRow(i: number) {
    rows.splice(i, 1);
    if (rows.length === 0) rows.push(blankRow());
  }

  // Rows that will be submitted: named and not already created.
  const readyCount = $derived(
    rows.filter(
      (r) => r.status !== "created" && r.name.trim(),
    ).length,
  );

  async function createAll() {
    if (busy || readyCount === 0) return;
    busy = true;
    summary = null;
    let created = 0;
    let failed = 0;
    for (const r of rows) {
      if (r.status === "created") continue;
      if (!r.name.trim()) continue;
      r.status = "saving";
      r.error = undefined;
      try {
        const res = await BulkCreateGroup.mutate({
          name: r.name.trim(),
          minQty: r.minQty,
        });
        if (res.errors?.length) {
          r.status = "error";
          r.error = res.errors[0].message;
          failed++;
        } else {
          r.status = "created";
          r.createdId = res.data?.createInterchangeGroup.id;
          created++;
        }
      } catch (e) {
        r.status = "error";
        r.error = e instanceof Error ? e.message : String(e);
        failed++;
      }
    }
    summary = { created, failed };
    busy = false;
  }

  // Drop the created rows, keeping the blanks and anything still failed/editable,
  // so the next batch starts clean.
  function clearCreated() {
    rows = rows.filter((r) => r.status !== "created");
    if (rows.length === 0) rows.push(blankRow());
    summary = null;
  }
</script>

<svelte:head><title>Bulk add interchange groups · Retale Console</title></svelte:head>

<div class="space-y-4">
  <a href="/interchange-groups" class="text-sm text-primary hover:underline">← Interchange Groups</a>

  <div class="flex items-center justify-between gap-3">
    <h1 class="text-xl font-semibold">Bulk add interchange groups</h1>
  </div>

  {#if !canCreate}
    <p class="text-sm text-muted-foreground">
      You don't have permission to create interchange groups.
    </p>
  {:else}
    <p class="text-sm text-muted-foreground">
      Draft interchange groups in the grid, then create them all at once. Only name is required. Rows are not saved until you click Create, and are discarded if you leave or refresh.
    </p>

    {#if summary}
      <p
        class="text-sm {summary.failed > 0
          ? 'text-destructive'
          : 'text-emerald-700'}"
      >
        Created {summary.created} group{summary.created === 1 ? "" : "s"}{summary.failed >
        0
          ? ` · ${summary.failed} failed`
          : ""}.
      </p>
    {/if}

    <div class="overflow-hidden rounded-lg border bg-card">
      <table class="w-full text-sm">
        <thead class="border-b bg-muted/50 text-left text-muted-foreground">
          <tr>
            <th class="w-10 px-3 py-2 text-right font-medium">#</th>
            <th class="px-3 py-2 font-medium">Name</th>
            <th class="w-40 px-3 py-2 font-medium">Min Qty</th>
            <th class="px-3 py-2 font-medium">Status</th>
            <th class="w-10 px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row, i (row)}
            <tr class="border-b last:border-0">
              <td class="px-3 py-1.5 text-right text-muted-foreground">{i + 1}</td>
              <td class="px-3 py-1.5">
                {#if row.status === "created"}
                  <span class="font-medium text-muted-foreground">
                    {row.name}
                  </span>
                {:else}
                  <Combobox
                    options={groupOptions}
                    bind:value={row.name}
                    placeholder="Group name"
                    disabled={busy}
                    createLabel={(q) => `Use "${q}"`}
                    onCreate={(q) => {
                      row.name = q;
                    }}
                  />
                {/if}
              </td>
              <td class="px-3 py-1.5">
                {#if row.status === "created"}
                  <span class="text-muted-foreground"
                    >{row.minQty ?? "—"}</span
                  >
                {:else}
                  <NumericInput bind:value={row.minQty} disabled={busy} placeholder="—" />
                {/if}
              </td>
              <td class="px-3 py-1.5">
                {#if row.status === "created"}
                  <span class="inline-flex items-center gap-1 text-emerald-700">
                    <Check class="size-4" /> Created
                  </span>
                {:else if row.status === "saving"}
                  <span class="text-muted-foreground">Saving…</span>
                {:else if row.status === "error"}
                  <span class="text-destructive">{row.error}</span>
                {:else}
                  <span class="text-muted-foreground"></span>
                {/if}
              </td>
              <td class="px-3 py-1.5 text-right">
                {#if row.status !== "created" && !(rows.length === 1 && rowEmpty(row))}
                  <IconButton
                    icon={X}
                    label="Remove row"
                    disabled={busy}
                    onclick={() => removeRow(i)}
                  />
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <div class="flex items-center justify-end gap-2">
      {#if rows.some((r) => r.status === "created")}
        <Button variant="ghost" size="sm" disabled={busy} onclick={clearCreated}>
          Clear created
        </Button>
      {/if}
      <Button size="sm" disabled={busy || readyCount === 0} onclick={createAll}>
        {busy ? "Creating…" : `Create ${readyCount} group${readyCount === 1 ? "" : "s"}`}
      </Button>
    </div>
  {/if}
</div>
