<script lang="ts">
  import { CachePolicy, graphql } from "$houdini";
  import { page } from "$app/state";
  import { Pencil } from "@lucide/svelte";
  import IconButton from "$lib/components/ui/icon-button.svelte";
  import type { Viewer } from "../+layout.server";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import type { PageData } from "./$types";

  graphql(`
    query UserAdmin {
      users {
        id
        username
        name
        isRoot
        twoFactorEnabled
        archivedAt
        createdAt
        roleIds
      }
      roles {
        id
        name
        isTemplate
      }
    }
  `);

  const CreateUser = graphql(`
    mutation ConsoleCreateUser(
      $username: String!
      $password: String!
      $name: String!
      $isRoot: Boolean
      $roleIds: [ID!]
    ) {
      createUser(
        username: $username
        password: $password
        name: $name
        isRoot: $isRoot
        roleIds: $roleIds
      ) {
        id
      }
    }
  `);

  const AssignRole = graphql(`
    mutation ConsoleAssignRole($userId: ID!, $roleId: ID!) {
      assignRole(userId: $userId, roleId: $roleId) {
        id
        roleIds
      }
    }
  `);

  const UnassignRole = graphql(`
    mutation ConsoleUnassignRole($userId: ID!, $roleId: ID!) {
      unassignRole(userId: $userId, roleId: $roleId) {
        id
        roleIds
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const UserAdmin = $derived(data.UserAdmin);
  const users = $derived($UserAdmin.data?.users ?? []);
  const roles = $derived($UserAdmin.data?.roles ?? []);
  const rolesById = $derived(new Map(roles.map((r) => [r.id, r])));

  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canManage = $derived(has("admin.user.manage"));

  // ---- Search & sort -------------------------------------------------------
  let search = $state("");
  const rows = $derived.by(() => {
    const q = search.trim().toLowerCase();
    const list = q
      ? users.filter(
          (u) =>
            u.username.toLowerCase().includes(q) ||
            u.name.toLowerCase().includes(q),
        )
      : users;
    return [...list].sort((a, b) => {
      const av = a.archivedAt ? 1 : 0;
      const bv = b.archivedAt ? 1 : 0;
      return av - bv || a.name.localeCompare(b.name);
    });
  });

  // ---- Inline role assignment ---------------------------------------------
  let editingRolesFor = $state<string | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function toggleRole(userId: string, roleId: string, on: boolean) {
    busy = true;
    error = null;
    try {
      const res = on
        ? await AssignRole.mutate({ userId, roleId })
        : await UnassignRole.mutate({ userId, roleId });
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      await UserAdmin.fetch({ policy: CachePolicy.NetworkOnly });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  // ---- New user form -------------------------------------------------------
  let showNew = $state(false);
  let newUsername = $state("");
  let newName = $state("");
  let newPassword = $state("");
  let newIsRoot = $state(false);
  let newRoleIds = $state<Set<string>>(new Set());

  function resetNewForm() {
    showNew = false;
    newUsername = "";
    newName = "";
    newPassword = "";
    newIsRoot = false;
    newRoleIds = new Set();
  }

  async function createUser() {
    if (!newUsername.trim() || !newName.trim() || !newPassword) return;
    busy = true;
    error = null;
    try {
      const res = await CreateUser.mutate({
        username: newUsername.trim(),
        password: newPassword,
        name: newName.trim(),
        isRoot: newIsRoot,
        roleIds: [...newRoleIds],
      });
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      resetNewForm();
      await UserAdmin.fetch({ policy: CachePolicy.NetworkOnly });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  const fmtDate = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleDateString("id-ID") : "—";
</script>

<svelte:head><title>Users · Retale Console</title></svelte:head>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <h1 class="text-xl font-semibold">Users</h1>
    <div class="flex items-center gap-3">
      <div class="w-64">
        <Input
          type="search"
          placeholder="Search users…"
          bind:value={search}
        />
      </div>
      <Button
        size="sm"
        disabled={busy || !canManage}
        onclick={() => (showNew = true)}
      >
        New user
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
          <span class="text-sm font-medium">Username</span>
          <Input bind:value={newUsername} autocomplete="off" />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Display name</span>
          <Input bind:value={newName} autocomplete="off" />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Initial password</span>
          <Input type="password" bind:value={newPassword} autocomplete="new-password" />
        </label>
        <label class="flex items-center gap-2 pt-6">
          <input type="checkbox" bind:checked={newIsRoot} />
          <span class="text-sm">Root (bypasses every permission check)</span>
        </label>
      </div>

      {#if !newIsRoot}
        <div>
          <p class="mb-1 text-sm font-medium">Roles</p>
          <div class="flex flex-wrap gap-1">
            {#each roles as r (r.id)}
              {@const on = newRoleIds.has(r.id)}
              <button
                type="button"
                class="rounded-full border px-2.5 py-0.5 text-xs transition-colors
                  {on
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-muted text-muted-foreground hover:bg-muted/40'}"
                onclick={() => {
                  const next = new Set(newRoleIds);
                  if (on) next.delete(r.id);
                  else next.add(r.id);
                  newRoleIds = next;
                }}
              >
                {r.name}
              </button>
            {/each}
            {#if roles.length === 0}
              <span class="text-xs text-muted-foreground">No roles defined yet.</span>
            {/if}
          </div>
        </div>
      {/if}

      <div class="flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={busy} onclick={resetNewForm}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={busy ||
            !newUsername.trim() ||
            !newName.trim() ||
            !newPassword}
          onclick={createUser}>Create user</Button
        >
      </div>
    </div>
  {/if}

  {#if $UserAdmin.fetching && users.length === 0}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if $UserAdmin.errors?.length}
    <p class="text-sm text-destructive">{$UserAdmin.errors[0].message}</p>
  {:else}
    <div class="overflow-hidden rounded-lg border bg-card">
      <table class="w-full text-sm">
        <thead class="border-b bg-muted/50 text-left text-muted-foreground">
          <tr>
            <th class="px-4 py-2 font-medium">Name</th>
            <th class="px-4 py-2 font-medium">Username</th>
            <th class="px-4 py-2 font-medium">Roles</th>
            <th class="px-4 py-2 font-medium">2FA</th>
            <th class="px-4 py-2 font-medium">Created</th>
            <th class="px-4 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as u (u.id)}
            <tr class="border-b last:border-0 align-top hover:bg-muted/40">
              <td class="px-4 py-2 font-medium">
                {u.name}
                {#if u.isRoot}
                  <Badge class="ml-1 bg-primary/10 text-primary">root</Badge>
                {/if}
              </td>
              <td class="px-4 py-2 font-mono text-xs">{u.username}</td>
              <td class="px-4 py-2">
                {#if u.isRoot}
                  <span class="text-xs text-muted-foreground">
                    All permissions
                  </span>
                {:else if editingRolesFor === u.id}
                  <div class="flex flex-wrap gap-1">
                    {#each roles as r (r.id)}
                      {@const on = u.roleIds.includes(r.id)}
                      <button
                        type="button"
                        disabled={busy || !canManage}
                        class="rounded-full border px-2 py-0.5 text-xs transition-colors disabled:opacity-50
                          {on
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-muted text-muted-foreground hover:bg-muted/40'}"
                        onclick={() => toggleRole(u.id, r.id, !on)}
                      >
                        {r.name}
                      </button>
                    {/each}
                    <button
                      type="button"
                      class="text-xs text-muted-foreground hover:underline"
                      onclick={() => (editingRolesFor = null)}>Done</button
                    >
                  </div>
                {:else}
                  <div class="flex flex-wrap items-center gap-1">
                    {#each u.roleIds as rid (rid)}
                      {@const r = rolesById.get(rid)}
                      <Badge class="bg-muted text-muted-foreground">
                        {r?.name ?? rid}
                      </Badge>
                    {/each}
                    {#if u.roleIds.length === 0}
                      <span class="text-xs text-muted-foreground">—</span>
                    {/if}
                    {#if canManage}
                      <IconButton
                        icon={Pencil}
                        label="Edit roles"
                        variant="primary"
                        class="ml-1"
                        onclick={() => (editingRolesFor = u.id)}
                      />
                    {/if}
                  </div>
                {/if}
              </td>
              <td class="px-4 py-2">
                {#if u.twoFactorEnabled}
                  <Badge class="bg-emerald-100 text-emerald-700">enabled</Badge>
                {:else}
                  <span class="text-xs text-muted-foreground">off</span>
                {/if}
              </td>
              <td class="px-4 py-2 text-muted-foreground">
                {fmtDate(u.createdAt)}
              </td>
              <td class="px-4 py-2">
                <Badge
                  class={u.archivedAt
                    ? "bg-muted text-muted-foreground"
                    : "bg-emerald-100 text-emerald-700"}
                >
                  {u.archivedAt ? "Archived" : "Active"}
                </Badge>
              </td>
            </tr>
          {/each}
          {#if rows.length === 0}
            <tr>
              <td colspan="6" class="px-4 py-10 text-center text-muted-foreground">
                No users match.
              </td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>
    <p class="text-sm text-muted-foreground">
      {rows.length} user{rows.length === 1 ? "" : "s"}
    </p>
  {/if}
</div>
