<script lang="ts">
  import { graphql } from "$houdini";
  import { page } from "$app/state";
  import type { Viewer } from "../../+layout.server";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import Textarea from "$lib/components/ui/textarea.svelte";
  import type { PageData } from "./$types";

  graphql(`
    query AddressBookView {
      addresses(includeArchived: true) {
        id
        label
        recipientName
        phone
        line
        notes
        isDefault
        archivedAt
        updatedAt
      }
    }
  `);

  const CreateAddress = graphql(`
    mutation ConsoleCreateAddress(
      $label: String!
      $recipientName: String
      $phone: String
      $line: String!
      $notes: String
      $isDefault: Boolean
    ) {
      createAddress(
        label: $label
        recipientName: $recipientName
        phone: $phone
        line: $line
        notes: $notes
        isDefault: $isDefault
      ) {
        id
      }
    }
  `);

  const UpdateAddress = graphql(`
    mutation ConsoleUpdateAddress(
      $id: ID!
      $label: String
      $recipientName: String
      $phone: String
      $line: String
      $notes: String
    ) {
      updateAddress(
        id: $id
        label: $label
        recipientName: $recipientName
        phone: $phone
        line: $line
        notes: $notes
      ) {
        id
      }
    }
  `);

  const SetDefaultAddress = graphql(`
    mutation ConsoleSetDefaultAddress($id: ID!) {
      setDefaultAddress(id: $id) {
        id
      }
    }
  `);

  const SetAddressArchived = graphql(`
    mutation ConsoleSetAddressArchived($id: ID!, $archived: Boolean!) {
      setAddressArchived(id: $id, archived: $archived) {
        id
      }
    }
  `);

  const DeleteAddress = graphql(`
    mutation ConsoleDeleteAddress($id: ID!) {
      deleteAddress(id: $id)
    }
  `);

  let { data }: { data: PageData } = $props();
  const View = $derived(data.AddressBookView);
  const addresses = $derived($View.data?.addresses ?? []);

  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canManage = $derived(has("admin.settings.manage"));

  let busy = $state(false);
  let feedback = $state<{ ok: boolean; text: string } | null>(null);

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
      await View.fetch();
      return true;
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
      return false;
    } finally {
      busy = false;
    }
  }

  // ---- New-address form ----------------------------------------------------
  let nLabel = $state("");
  let nRecipient = $state("");
  let nPhone = $state("");
  let nLine = $state("");
  let nNotes = $state("");
  let nDefault = $state(false);

  async function create() {
    if (!nLabel.trim() || !nLine.trim()) return;
    const ok = await run("Address", () =>
      CreateAddress.mutate({
        label: nLabel.trim(),
        recipientName: nRecipient.trim() || null,
        phone: nPhone.trim() || null,
        line: nLine.trim(),
        notes: nNotes.trim() || null,
        isDefault: nDefault,
      }),
    );
    if (ok) {
      nLabel = nRecipient = nPhone = nLine = nNotes = "";
      nDefault = false;
    }
  }

  // ---- Per-row editing -----------------------------------------------------
  // Working copies keyed by id; seeded lazily on first edit so a refetch
  // doesn't clobber an in-progress edit.
  type Draft = { label: string; recipientName: string; phone: string; line: string; notes: string };
  let drafts = $state<Record<string, Draft>>({});
  const draftFor = (a: (typeof addresses)[number]): Draft => {
    if (!drafts[a.id]) {
      drafts[a.id] = {
        label: a.label,
        recipientName: a.recipientName ?? "",
        phone: a.phone ?? "",
        line: a.line,
        notes: a.notes ?? "",
      };
    }
    return drafts[a.id];
  };

  async function saveRow(id: string) {
    const d = drafts[id];
    if (!d || !d.label.trim() || !d.line.trim()) return;
    await run("Address", () =>
      UpdateAddress.mutate({
        id,
        label: d.label.trim(),
        recipientName: d.recipientName.trim() || null,
        phone: d.phone.trim() || null,
        line: d.line.trim(),
        notes: d.notes.trim() || null,
      }),
    );
  }

  async function makeDefault(id: string) {
    await run("Default", () => SetDefaultAddress.mutate({ id }));
  }
  async function toggleArchived(id: string, archived: boolean) {
    await run("Address", () => SetAddressArchived.mutate({ id, archived }));
  }
  async function remove(id: string, label: string) {
    if (!confirm(`Permanently delete "${label}"? Vendors using it revert to the default address.`))
      return;
    await run("Address", () => DeleteAddress.mutate({ id }));
  }
</script>

<svelte:head><title>Ship-to addresses · Retale Console</title></svelte:head>

<div class="max-w-2xl space-y-4">
  <div>
    <a href="/settings" class="text-sm text-muted-foreground hover:text-foreground"
      >← Back to settings</a
    >
    <h1 class="mt-2 text-xl font-semibold">Ship-to addresses</h1>
    <p class="text-sm text-muted-foreground">
      Your own locations, printed as “Ship To” on purchase orders. Each vendor
      can default to one; the address flagged <em>default</em> is the fallback.
    </p>
  </div>

  {#if feedback}
    <p class="text-sm {feedback.ok ? 'text-emerald-700' : 'text-destructive'}">
      {feedback.text}
    </p>
  {/if}

  {#if !canManage}
    <p class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
      You don't have permission to manage addresses.
    </p>
  {/if}

  {#if $View.fetching && addresses.length === 0}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if $View.errors?.length}
    <p class="text-sm text-destructive">{$View.errors[0].message}</p>
  {:else}
    <!-- Existing addresses -->
    {#each addresses as a (a.id)}
      {@const d = draftFor(a)}
      <section
        class="space-y-3 rounded-lg border bg-card p-4 {a.archivedAt ? 'opacity-60' : ''}"
      >
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <h2 class="text-sm font-semibold">{a.label}</h2>
            {#if a.isDefault}
              <Badge class="bg-primary/10 text-primary">default</Badge>
            {/if}
            {#if a.archivedAt}
              <Badge class="bg-muted text-muted-foreground">archived</Badge>
            {/if}
          </div>
          <div class="flex items-center gap-2">
            {#if !a.isDefault && !a.archivedAt}
              <Button variant="outline" size="sm" disabled={busy || !canManage}
                onclick={() => makeDefault(a.id)}>Set default</Button
              >
            {/if}
            <Button variant="outline" size="sm" disabled={busy || !canManage}
              onclick={() => toggleArchived(a.id, a.archivedAt == null)}
              >{a.archivedAt ? "Restore" : "Archive"}</Button
            >
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <label class="space-y-1">
            <span class="text-xs font-medium">Label</span>
            <Input bind:value={d.label} disabled={!canManage} />
          </label>
          <label class="space-y-1">
            <span class="text-xs font-medium">Recipient / PIC</span>
            <Input bind:value={d.recipientName} disabled={!canManage} />
          </label>
          <label class="space-y-1">
            <span class="text-xs font-medium">Phone</span>
            <Input bind:value={d.phone} disabled={!canManage} />
          </label>
        </div>
        <label class="block space-y-1">
          <span class="text-xs font-medium">Address</span>
          <Textarea bind:value={d.line} disabled={!canManage} class="min-h-16" />
        </label>
        <label class="block space-y-1">
          <span class="text-xs font-medium">Notes</span>
          <Input bind:value={d.notes} disabled={!canManage} />
        </label>

        <div class="flex justify-between">
          <Button
            variant="ghost"
            size="sm"
            class="text-destructive"
            disabled={busy || !canManage}
            onclick={() => remove(a.id, a.label)}>Delete</Button
          >
          <Button size="sm" disabled={busy || !canManage || !d.label.trim() || !d.line.trim()}
            onclick={() => saveRow(a.id)}>Save</Button
          >
        </div>
      </section>
    {/each}

    {#if addresses.length === 0}
      <p class="text-sm text-muted-foreground">No addresses yet.</p>
    {/if}

    <!-- Add new -->
    {#if canManage}
      <section class="space-y-3 rounded-lg border border-dashed bg-card p-4">
        <h2 class="text-sm font-semibold">Add an address</h2>
        <div class="grid grid-cols-2 gap-3">
          <label class="space-y-1">
            <span class="text-xs font-medium">Label</span>
            <Input bind:value={nLabel} placeholder="e.g. Main Store" />
          </label>
          <label class="space-y-1">
            <span class="text-xs font-medium">Recipient / PIC</span>
            <Input bind:value={nRecipient} />
          </label>
          <label class="space-y-1">
            <span class="text-xs font-medium">Phone</span>
            <Input bind:value={nPhone} />
          </label>
        </div>
        <label class="block space-y-1">
          <span class="text-xs font-medium">Address</span>
          <Textarea bind:value={nLine} class="min-h-16" placeholder="Street, area, city, postal code" />
        </label>
        <label class="block space-y-1">
          <span class="text-xs font-medium">Notes</span>
          <Input bind:value={nNotes} />
        </label>
        <div class="flex items-center justify-between">
          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" bind:checked={nDefault} />
            Make this the default ship-to
          </label>
          <Button size="sm" disabled={busy || !nLabel.trim() || !nLine.trim()} onclick={create}>
            Add address
          </Button>
        </div>
      </section>
    {/if}
  {/if}
</div>
