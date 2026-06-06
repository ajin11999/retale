<script lang="ts">
  import { CachePolicy, graphql } from "$houdini";
  import { page } from "$app/state";
  import { Archive, ArchiveRestore, Pencil, Trash2 } from "@lucide/svelte";
  import IconButton from "$lib/components/ui/icon-button.svelte";
  import type { Viewer } from "../+layout.server";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Combobox from "$lib/components/ui/combobox.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import Textarea from "$lib/components/ui/textarea.svelte";
  import type { PageData } from "./$types";

  // Query document — Houdini scans this for codegen. The live store is
  // supplied by +page.ts through `data` (route-store wiring is unavailable).
  graphql(`
    query RegisterList {
      pointsOfSale(includeArchived: true) {
        id
        locationId
        code
        name
        notes
        archivedAt
      }
      locations(includeArchived: false) {
        id
        name
        parentId
      }
    }
  `);

  const CreatePos = graphql(`
    mutation ConsoleCreatePos(
      $locationId: ID!
      $code: String!
      $name: String!
      $notes: String
    ) {
      createPointOfSale(
        locationId: $locationId
        code: $code
        name: $name
        notes: $notes
      ) {
        id
      }
    }
  `);

  const UpdatePos = graphql(`
    mutation ConsoleUpdatePos(
      $id: ID!
      $locationId: ID
      $code: String
      $name: String
      $notes: String
    ) {
      updatePointOfSale(
        id: $id
        locationId: $locationId
        code: $code
        name: $name
        notes: $notes
      ) {
        id
        locationId
        code
        name
        notes
      }
    }
  `);

  const SetPosArchived = graphql(`
    mutation ConsoleSetPosArchived($id: ID!, $archived: Boolean!) {
      setPointOfSaleArchived(id: $id, archived: $archived) {
        id
        archivedAt
      }
    }
  `);

  const HardDeletePos = graphql(`
    mutation ConsoleHardDeletePos($id: ID!) {
      hardDeletePointOfSale(id: $id)
    }
  `);

  let { data }: { data: PageData } = $props();
  const RegisterList = $derived(data.RegisterList);
  const registers = $derived($RegisterList.data?.pointsOfSale ?? []);
  const locations = $derived($RegisterList.data?.locations ?? []);

  // ---- Viewer permissions --------------------------------------------------
  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canCreate = $derived(has("pos.create"));
  const canEdit = $derived(has("pos.edit"));
  const canArchive = $derived(has("pos.archive"));
  const canHardDelete = $derived(has("pos.hard_delete"));

  // ---- Location labels -----------------------------------------------------
  // Full ancestry path per location ("Warehouse › Aisle 3") so both the picker
  // and the table read the register's location with hierarchy context.
  const pathById = $derived.by(() => {
    const byId = new Map(locations.map((l) => [l.id, l]));
    const m = new Map<string, string>();
    const pathOf = (id: string): string => {
      const cached = m.get(id);
      if (cached) return cached;
      const l = byId.get(id);
      if (!l) return id;
      const path = l.parentId
        ? `${pathOf(l.parentId)} › ${l.name}`
        : l.name;
      m.set(id, path);
      return path;
    };
    for (const l of locations) pathOf(l.id);
    return m;
  });

  const locationOptions = $derived(
    [...locations]
      .map((l) => ({ value: l.id, label: pathById.get(l.id) ?? l.name }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  );

  // ---- Search --------------------------------------------------------------
  let search = $state("");
  const rows = $derived.by(() => {
    const q = search.trim().toLowerCase();
    const list = registers.filter((r) => {
      if (!q) return true;
      return (
        r.code.toLowerCase().includes(q) ||
        r.name.toLowerCase().includes(q) ||
        (pathById.get(r.locationId) ?? "").toLowerCase().includes(q)
      );
    });
    // Active first, then by code.
    return [...list].sort((a, b) => {
      const av = a.archivedAt ? 1 : 0;
      const bv = b.archivedAt ? 1 : 0;
      return av - bv || a.code.localeCompare(b.code);
    });
  });

  // ---- Editor --------------------------------------------------------------
  interface RegisterDraft {
    id: string | null; // null → a new register
    locationId: string;
    code: string;
    name: string;
    notes: string;
  }

  let draft = $state<RegisterDraft | null>(null);
  let busy = $state(false);
  let feedback = $state<{ ok: boolean; text: string } | null>(null);

  function newRegister() {
    draft = {
      id: null,
      locationId: locationOptions[0]?.value ?? "",
      code: "",
      name: "",
      notes: "",
    };
  }

  function editRegister(r: (typeof registers)[number]) {
    draft = {
      id: r.id,
      locationId: r.locationId,
      code: r.code,
      name: r.name,
      notes: r.notes ?? "",
    };
  }

  /** Run a mutation, surfacing the first GraphQL error as feedback. */
  async function run(
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
      feedback = { ok: true, text: "Register saved." };
      return true;
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
      return false;
    } finally {
      busy = false;
    }
  }

  const draftValid = $derived(
    !!draft && !!draft.locationId && !!draft.code.trim() && !!draft.name.trim(),
  );

  async function saveRegister() {
    const d = draft;
    if (!d || !draftValid) return;
    const ok = await run(() =>
      d.id
        ? UpdatePos.mutate({
            id: d.id,
            locationId: d.locationId,
            code: d.code.trim(),
            name: d.name.trim(),
            notes: d.notes.trim() || null,
          })
        : CreatePos.mutate({
            locationId: d.locationId,
            code: d.code.trim(),
            name: d.name.trim(),
            notes: d.notes.trim() || null,
          }),
    );
    if (ok) {
      draft = null;
      await RegisterList.fetch({ policy: CachePolicy.NetworkOnly });
    }
  }

  async function toggleArchived(r: (typeof registers)[number]) {
    const ok = await run(() =>
      SetPosArchived.mutate({ id: r.id, archived: r.archivedAt == null }),
    );
    if (ok) await RegisterList.fetch({ policy: CachePolicy.NetworkOnly });
  }

  async function hardDelete(r: (typeof registers)[number]) {
    if (
      !confirm(
        `Permanently delete "${r.code} — ${r.name}"? Refused by the API if any ` +
          `session references it.`,
      )
    )
      return;
    const ok = await run(() => HardDeletePos.mutate({ id: r.id }));
    if (ok) {
      if (draft?.id === r.id) draft = null;
      await RegisterList.fetch({ policy: CachePolicy.NetworkOnly });
    }
  }
</script>

<svelte:head><title>Registers · Retale Console</title></svelte:head>

<div class="space-y-4">
  <div class="flex items-center justify-between gap-3">
    <h1 class="text-xl font-semibold">Registers</h1>
    <div class="flex items-center gap-2">
      <div class="w-64">
        <Input type="search" placeholder="Search registers…" bind:value={search} />
      </div>
      <Button
        size="sm"
        disabled={busy || !canCreate || locationOptions.length === 0}
        onclick={newRegister}
      >
        New register
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
      You have read-only access to registers — editing is disabled.
    </p>
  {/if}

  {#if locationOptions.length === 0}
    <p
      class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
    >
      Create a location first — every register must belong to one.
    </p>
  {/if}

  {#if draft}
    <div class="space-y-3 rounded-lg border bg-card p-5">
      <h2 class="text-sm font-semibold">
        {draft.id ? "Edit register" : "New register"}
      </h2>
      <div class="grid grid-cols-2 gap-4">
        <label class="space-y-1">
          <span class="text-sm font-medium">Code</span>
          <Input
            bind:value={draft.code}
            placeholder="POS-01"
            disabled={!canEdit}
          />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Name</span>
          <Input
            bind:value={draft.name}
            placeholder="Front register"
            disabled={!canEdit}
          />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Location</span>
          <Combobox
            options={locationOptions}
            bind:value={draft.locationId}
            placeholder="Search location…"
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
          disabled={busy || !canEdit || !draftValid}
          onclick={saveRegister}
        >
          {draft.id ? "Save register" : "Create register"}
        </Button>
      </div>
    </div>
  {/if}

  {#if $RegisterList.fetching && registers.length === 0}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if $RegisterList.errors?.length}
    <p class="text-sm text-destructive">{$RegisterList.errors[0].message}</p>
  {:else}
    <div class="overflow-hidden rounded-lg border bg-card">
      <table class="w-full text-sm">
        <thead class="border-b bg-muted/50 text-left text-muted-foreground">
          <tr>
            <th class="px-4 py-2 font-medium">Code</th>
            <th class="px-4 py-2 font-medium">Name</th>
            <th class="px-4 py-2 font-medium">Location</th>
            <th class="px-4 py-2 font-medium">Status</th>
            <th class="px-4 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as r (r.id)}
            <tr class="border-b last:border-0 hover:bg-muted/40">
              <td class="px-4 py-2">
                <a
                  href={`/sessions?pos=${r.id}`}
                  class="font-mono text-xs text-primary hover:underline"
                  title="View this register's sessions"
                >
                  {r.code}
                </a>
              </td>
              <td class="px-4 py-2">
                <a
                  href={`/sessions?pos=${r.id}`}
                  class="font-medium text-primary hover:underline"
                  title="View this register's sessions"
                >
                  {r.name}
                </a>
              </td>
              <td class="px-4 py-2 text-muted-foreground">
                {pathById.get(r.locationId) ?? "—"}
              </td>
              <td class="px-4 py-2">
                <Badge
                  class={r.archivedAt
                    ? "bg-muted text-muted-foreground"
                    : "bg-emerald-100 text-emerald-700"}
                >
                  {r.archivedAt ? "Archived" : "Active"}
                </Badge>
              </td>
              <td class="px-4 py-2 text-right whitespace-nowrap">
                <span class="inline-flex items-center gap-0.5">
                  <IconButton
                    icon={Pencil}
                    label="Edit"
                    variant="primary"
                    disabled={busy || !canEdit}
                    onclick={() => editRegister(r)}
                  />
                  <IconButton
                    icon={r.archivedAt ? ArchiveRestore : Archive}
                    label={r.archivedAt ? "Restore" : "Archive"}
                    disabled={busy || !canArchive}
                    onclick={() => toggleArchived(r)}
                  />
                  {#if canHardDelete}
                    <IconButton
                      icon={Trash2}
                      label="Delete"
                      variant="destructive"
                      disabled={busy}
                      onclick={() => hardDelete(r)}
                    />
                  {/if}
                </span>
              </td>
            </tr>
          {/each}
          {#if rows.length === 0}
            <tr>
              <td colspan="5" class="px-4 py-10 text-center text-muted-foreground">
                {search.trim() ? "No registers match." : "No registers yet."}
              </td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>
    <p class="text-sm text-muted-foreground">
      {rows.length} register{rows.length === 1 ? "" : "s"}
    </p>
  {/if}
</div>
