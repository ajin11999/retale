<script lang="ts">
  import { CachePolicy, graphql } from "$houdini";
  import { page } from "$app/state";
  import type { Viewer } from "../+layout.server";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import type { PageData } from "./$types";

  // Roles + the permission catalog in one round-trip — the editor groups keys
  // by their domain prefix (the substring before the first dot).
  graphql(`
    query RoleAdmin {
      roles {
        id
        name
        description
        isTemplate
        archivedAt
        permissionKeys
      }
      permissionCatalog
    }
  `);

  const CreateRole = graphql(`
    mutation ConsoleCreateRole(
      $name: String!
      $description: String
      $permissionKeys: [String!]!
    ) {
      createRole(
        name: $name
        description: $description
        permissionKeys: $permissionKeys
      ) {
        id
        name
        description
        isTemplate
        archivedAt
        permissionKeys
      }
    }
  `);

  const CloneRole = graphql(`
    mutation ConsoleCloneRole($roleId: ID!, $name: String!) {
      cloneRole(roleId: $roleId, name: $name) {
        id
        name
        description
        isTemplate
        archivedAt
        permissionKeys
      }
    }
  `);

  const SetRolePermissions = graphql(`
    mutation ConsoleSetRolePermissions(
      $roleId: ID!
      $permissionKeys: [String!]!
    ) {
      setRolePermissions(roleId: $roleId, permissionKeys: $permissionKeys) {
        id
        permissionKeys
      }
    }
  `);

  const DeleteRole = graphql(`
    mutation ConsoleDeleteRole($roleId: ID!) {
      deleteRole(roleId: $roleId)
    }
  `);

  let { data }: { data: PageData } = $props();
  const RoleAdmin = $derived(data.RoleAdmin);
  const roles = $derived($RoleAdmin.data?.roles ?? []);
  const catalog = $derived($RoleAdmin.data?.permissionCatalog ?? []);

  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canManage = $derived(has("admin.role.manage"));

  // Group permission keys by their domain prefix for the editor UI.
  const catalogByDomain = $derived.by(() => {
    const groups = new Map<string, string[]>();
    for (const k of catalog) {
      const domain = k.split(".")[0] ?? "other";
      const list = groups.get(domain) ?? [];
      list.push(k);
      groups.set(domain, list);
    }
    for (const list of groups.values()) list.sort();
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  });

  // ---- Selection & editor state -------------------------------------------
  let selectedId = $state<string | null>(null);
  const selected = $derived(roles.find((r) => r.id === selectedId) ?? null);

  // Working set for the editor. We rebuild it whenever the selection
  // changes so the editor's draft mirrors what the server has.
  let draft = $state<Set<string>>(new Set());
  let dirty = $state(false);
  $effect(() => {
    if (selected) {
      draft = new Set(selected.permissionKeys);
      dirty = false;
    } else {
      draft = new Set();
      dirty = false;
    }
  });

  function toggleKey(key: string) {
    if (!selected || selected.isTemplate || !canManage) return;
    const next = new Set(draft);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    draft = next;
    dirty = true;
  }

  function toggleDomain(domainKeys: string[], on: boolean) {
    if (!selected || selected.isTemplate || !canManage) return;
    const next = new Set(draft);
    for (const k of domainKeys) {
      if (on) next.add(k);
      else next.delete(k);
    }
    draft = next;
    dirty = true;
  }

  // ---- Mutations -----------------------------------------------------------
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function savePermissions() {
    if (!selected || !dirty) return;
    busy = true;
    error = null;
    try {
      const res = await SetRolePermissions.mutate({
        roleId: selected.id,
        permissionKeys: [...draft].sort(),
      });
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      dirty = false;
      await RoleAdmin.fetch({ policy: CachePolicy.NetworkOnly });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function cloneSelected() {
    if (!selected) return;
    const name = prompt(`Clone "${selected.name}" as:`, `${selected.name} copy`);
    if (!name) return;
    busy = true;
    error = null;
    try {
      const res = await CloneRole.mutate({ roleId: selected.id, name });
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      const newId = res.data?.cloneRole.id ?? null;
      await RoleAdmin.fetch({ policy: CachePolicy.NetworkOnly });
      if (newId) selectedId = newId;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function deleteSelected() {
    if (!selected || selected.isTemplate) return;
    if (!confirm(`Delete role "${selected.name}"?`)) return;
    busy = true;
    error = null;
    try {
      const res = await DeleteRole.mutate({ roleId: selected.id });
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      selectedId = null;
      await RoleAdmin.fetch({ policy: CachePolicy.NetworkOnly });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  // ---- New role form -------------------------------------------------------
  let newName = $state<string | null>(null);
  let newDescription = $state("");

  async function createRole() {
    const name = (newName ?? "").trim();
    if (!name) return;
    busy = true;
    error = null;
    try {
      const res = await CreateRole.mutate({
        name,
        description: newDescription.trim() || null,
        permissionKeys: [],
      });
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      const id = res.data?.createRole.id ?? null;
      newName = null;
      newDescription = "";
      await RoleAdmin.fetch({ policy: CachePolicy.NetworkOnly });
      if (id) selectedId = id;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>Roles · Retale Console</title></svelte:head>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <h1 class="text-xl font-semibold">Roles</h1>
    <Button
      size="sm"
      disabled={busy || !canManage}
      onclick={() => (newName = "")}
    >
      New role
    </Button>
  </div>

  {#if error}
    <p class="text-sm text-destructive">{error}</p>
  {/if}

  {#if newName !== null}
    <div class="space-y-2 rounded-lg border bg-card p-4">
      <div class="flex items-end gap-2">
        <label class="flex-1 space-y-1">
          <span class="text-sm font-medium">Role name</span>
          <Input bind:value={newName} placeholder="e.g. Stockroom" />
        </label>
        <label class="flex-1 space-y-1">
          <span class="text-sm font-medium">Description (optional)</span>
          <Input bind:value={newDescription} />
        </label>
        <Button
          size="sm"
          disabled={busy || !(newName ?? "").trim()}
          onclick={createRole}>Create</Button
        >
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onclick={() => {
            newName = null;
            newDescription = "";
          }}>Cancel</Button
        >
      </div>
      <p class="text-xs text-muted-foreground">
        New roles start with no permissions — assign them after creation.
      </p>
    </div>
  {/if}

  {#if $RoleAdmin.fetching && roles.length === 0}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if $RoleAdmin.errors?.length}
    <p class="text-sm text-destructive">{$RoleAdmin.errors[0].message}</p>
  {:else}
    <div class="grid grid-cols-[18rem_1fr] gap-4">
      <!-- Role list -->
      <div class="overflow-hidden rounded-lg border bg-card">
        <ul class="divide-y">
          {#each roles as r (r.id)}
            <li>
              <button
                class="flex w-full items-center justify-between px-4 py-2 text-left text-sm transition-colors
                  {selectedId === r.id
                  ? 'bg-accent'
                  : 'hover:bg-muted/50'}"
                onclick={() => (selectedId = r.id)}
              >
                <span class="flex flex-col">
                  <span class="font-medium">{r.name}</span>
                  {#if r.description}
                    <span class="text-xs text-muted-foreground">
                      {r.description}
                    </span>
                  {/if}
                </span>
                {#if r.isTemplate}
                  <Badge class="bg-muted text-muted-foreground">template</Badge>
                {/if}
              </button>
            </li>
          {/each}
          {#if roles.length === 0}
            <li class="px-4 py-10 text-center text-sm text-muted-foreground">
              No roles defined.
            </li>
          {/if}
        </ul>
      </div>

      <!-- Permission editor -->
      <div class="rounded-lg border bg-card p-4">
        {#if !selected}
          <p class="text-sm text-muted-foreground">
            Select a role to view its permissions.
          </p>
        {:else}
          <div class="mb-3 flex items-start justify-between gap-3">
            <div>
              <h2 class="text-lg font-semibold">{selected.name}</h2>
              {#if selected.description}
                <p class="text-sm text-muted-foreground">
                  {selected.description}
                </p>
              {/if}
              {#if selected.isTemplate}
                <p class="mt-1 text-xs text-muted-foreground">
                  Templates are read-only — clone to edit.
                </p>
              {/if}
            </div>
            <div class="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !canManage}
                onclick={cloneSelected}>Clone</Button
              >
              {#if !selected.isTemplate}
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy || !canManage}
                  onclick={deleteSelected}>Delete</Button
                >
              {/if}
            </div>
          </div>

          <div class="mb-3 flex items-center justify-between border-y py-2">
            <span class="text-sm text-muted-foreground">
              {draft.size} of {catalog.length} permissions
            </span>
            <Button
              size="sm"
              disabled={busy || !dirty || selected.isTemplate || !canManage}
              onclick={savePermissions}
            >
              {dirty ? "Save changes" : "Saved"}
            </Button>
          </div>

          <div class="space-y-4">
            {#each catalogByDomain as [domain, keys] (domain)}
              {@const onCount = keys.filter((k) => draft.has(k)).length}
              {@const allOn = onCount === keys.length}
              <div>
                <div class="mb-1 flex items-center justify-between">
                  <h3 class="text-sm font-semibold capitalize">
                    {domain}
                    <span class="ml-1 text-xs font-normal text-muted-foreground">
                      {onCount}/{keys.length}
                    </span>
                  </h3>
                  <button
                    type="button"
                    class="text-xs text-primary hover:underline disabled:opacity-50"
                    disabled={selected.isTemplate || !canManage}
                    onclick={() => toggleDomain(keys, !allOn)}
                  >
                    {allOn ? "Clear all" : "Select all"}
                  </button>
                </div>
                <div class="grid grid-cols-2 gap-1">
                  {#each keys as key (key)}
                    <label
                      class="flex items-center gap-2 rounded px-2 py-1 text-sm
                        {selected.isTemplate
                        ? 'cursor-default'
                        : 'cursor-pointer hover:bg-muted/40'}"
                    >
                      <input
                        type="checkbox"
                        checked={draft.has(key)}
                        disabled={selected.isTemplate || !canManage}
                        onchange={() => toggleKey(key)}
                      />
                      <span class="font-mono text-xs">{key}</span>
                    </label>
                  {/each}
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
