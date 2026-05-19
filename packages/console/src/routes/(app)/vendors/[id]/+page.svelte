<script lang="ts">
  import { graphql } from "$houdini";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import type { Viewer } from "../../+layout.server";
  import { formatMoney } from "$lib/utils";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import Select from "$lib/components/ui/select.svelte";
  import Textarea from "$lib/components/ui/textarea.svelte";
  import type { PageData } from "./$types";

  // Query document — Houdini scans this for codegen. The live store is
  // supplied by +page.ts through `data` (route-store wiring is unavailable).
  graphql(`
    query VendorDetail($id: ID!) {
      vendor(id: $id) {
        id
        name
        phone
        email
        address
        taxId
        notes
        leadTimeDays
        preferredSendChannel
        balanceMinor
        archivedAt
      }
    }
  `);

  // The AP ledger needs report.ap_aging.view — a separate query, fetched
  // imperatively only for viewers who hold that key (else it would error the
  // combined document for everyone else).
  const VendorLedger = graphql(`
    query ConsoleVendorLedger($vendorId: ID!) {
      vendorLedger(vendorId: $vendorId, limit: 100) {
        id
        type
        amountMinor
        refType
        note
        createdAt
      }
    }
  `);

  const UpdateVendor = graphql(`
    mutation ConsoleUpdateVendor(
      $id: ID!
      $name: String
      $phone: String
      $email: String
      $address: String
      $taxId: String
      $notes: String
      $leadTimeDays: Int
      $preferredSendChannel: VendorSendChannel
    ) {
      updateVendor(
        id: $id
        name: $name
        phone: $phone
        email: $email
        address: $address
        taxId: $taxId
        notes: $notes
        leadTimeDays: $leadTimeDays
        preferredSendChannel: $preferredSendChannel
      ) {
        id
        name
        phone
        email
        address
        taxId
        notes
        leadTimeDays
        preferredSendChannel
      }
    }
  `);

  const SetVendorArchived = graphql(`
    mutation ConsoleSetVendorArchived($id: ID!, $archived: Boolean!) {
      setVendorArchived(id: $id, archived: $archived) {
        id
        archivedAt
      }
    }
  `);

  const HardDeleteVendor = graphql(`
    mutation ConsoleHardDeleteVendor($id: ID!) {
      hardDeleteVendor(id: $id)
    }
  `);

  const RecordVendorPayment = graphql(`
    mutation ConsoleRecordVendorPayment(
      $vendorId: ID!
      $amountMinor: Float!
      $note: String
    ) {
      recordVendorPayment(
        vendorId: $vendorId
        amountMinor: $amountMinor
        note: $note
      ) {
        id
        balanceMinor
      }
    }
  `);

  const AdjustVendorBalance = graphql(`
    mutation ConsoleAdjustVendorBalance(
      $vendorId: ID!
      $amountMinor: Float!
      $note: String!
    ) {
      adjustVendorBalance(
        vendorId: $vendorId
        amountMinor: $amountMinor
        note: $note
      ) {
        id
        balanceMinor
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const VendorDetail = $derived(data.VendorDetail);
  const vendor = $derived($VendorDetail.data?.vendor);

  // ---- Viewer permissions --------------------------------------------------
  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canEdit = $derived(has("vendor.edit"));
  const canArchive = $derived(has("vendor.archive"));
  const canRecordPayment = $derived(has("vendor.record_payment"));
  const canAdjust = $derived(has("vendor.adjustment"));
  const canHardDelete = $derived(has("vendor.hard_delete"));
  const canViewLedger = $derived(has("report.ap_aging.view"));

  // ---- Header form ---------------------------------------------------------
  const CHANNELS = ["", "whatsapp", "email"];
  interface VendorForm {
    name: string;
    phone: string;
    email: string;
    address: string;
    taxId: string;
    notes: string;
    leadTimeDays: number | null;
    preferredSendChannel: string;
  }
  let form = $state<VendorForm>({
    name: "",
    phone: "",
    email: "",
    address: "",
    taxId: "",
    notes: "",
    leadTimeDays: null,
    preferredSendChannel: "",
  });

  // Reset the form when a different vendor loads — not on a plain refetch, so
  // in-progress edits survive.
  let syncedId = $state("");
  $effect(() => {
    const v = vendor;
    if (v && v.id !== syncedId) {
      syncedId = v.id;
      form = {
        name: v.name,
        phone: v.phone ?? "",
        email: v.email ?? "",
        address: v.address ?? "",
        taxId: v.taxId ?? "",
        notes: v.notes ?? "",
        leadTimeDays: v.leadTimeDays ?? null,
        preferredSendChannel: v.preferredSendChannel ?? "",
      };
    }
  });

  // Load the ledger once, for viewers allowed to see it.
  let ledgerLoaded = $state(false);
  $effect(() => {
    if (vendor && canViewLedger && !ledgerLoaded) {
      ledgerLoaded = true;
      VendorLedger.fetch({ variables: { vendorId: vendor.id } });
    }
  });
  const ledger = $derived($VendorLedger.data?.vendorLedger ?? []);

  let busy = $state(false);
  let feedback = $state<{ ok: boolean; text: string } | null>(null);

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

  const refetch = async () => {
    if (!vendor) return;
    await VendorDetail.fetch({ variables: { id: vendor.id } });
    if (canViewLedger) {
      await VendorLedger.fetch({ variables: { vendorId: vendor.id } });
    }
  };

  async function saveVendor() {
    if (!vendor) return;
    await run("Vendor", () =>
      UpdateVendor.mutate({
        id: vendor.id,
        name: form.name.trim(),
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        address: form.address.trim() || null,
        taxId: form.taxId.trim() || null,
        notes: form.notes.trim() || null,
        leadTimeDays: form.leadTimeDays,
        preferredSendChannel: (form.preferredSendChannel || null) as never,
      }),
    );
  }

  async function toggleArchived() {
    if (!vendor) return;
    const ok = await run("Vendor", () =>
      SetVendorArchived.mutate({
        id: vendor.id,
        archived: vendor.archivedAt == null,
      }),
    );
    if (ok) await refetch();
  }

  async function hardDelete() {
    if (!vendor) return;
    if (
      !confirm(
        `Permanently delete "${vendor.name}"? This cannot be undone.`,
      )
    )
      return;
    const ok = await run("Vendor", () =>
      HardDeleteVendor.mutate({ id: vendor.id }),
    );
    if (ok) await goto("/vendors");
  }

  // ---- Payment / adjustment ------------------------------------------------
  let payAmount = $state<number | null>(null);
  let payNote = $state("");

  async function recordPayment() {
    if (!vendor || !payAmount || payAmount <= 0) return;
    const ok = await run("Payment", () =>
      RecordVendorPayment.mutate({
        vendorId: vendor.id,
        amountMinor: payAmount as number,
        note: payNote.trim() || null,
      }),
    );
    if (ok) {
      payAmount = null;
      payNote = "";
      await refetch();
    }
  }

  let adjAmount = $state<number | null>(null);
  let adjNote = $state("");

  async function adjustBalance() {
    if (!vendor || !adjAmount || !adjNote.trim()) return;
    const ok = await run("Adjustment", () =>
      AdjustVendorBalance.mutate({
        vendorId: vendor.id,
        amountMinor: adjAmount as number,
        note: adjNote.trim(),
      }),
    );
    if (ok) {
      adjAmount = null;
      adjNote = "";
      await refetch();
    }
  }

  const fmtDateTime = (iso: string) => new Date(iso).toLocaleString("id-ID");
</script>

<svelte:head>
  <title>{vendor ? vendor.name : "Vendor"} · Retale Console</title>
</svelte:head>

<div class="mx-auto max-w-3xl space-y-6">
  <a href="/vendors" class="text-sm text-muted-foreground hover:text-foreground"
    >← Back to vendors</a
  >

  {#if $VendorDetail.fetching && !vendor}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if !vendor}
    <p class="text-sm text-destructive">Vendor not found.</p>
  {:else}
    <div class="flex items-start justify-between gap-4">
      <div>
        <h1 class="text-xl font-semibold">{vendor.name}</h1>
        <p class="text-sm text-muted-foreground">
          AP balance
          <span class="font-medium text-foreground"
            >{formatMoney(vendor.balanceMinor)}</span
          >
          {vendor.balanceMinor > 0 ? "(we owe)" : ""}
        </p>
      </div>
      <div class="flex items-center gap-3">
        <Badge
          class={vendor.archivedAt
            ? "bg-muted text-muted-foreground"
            : "bg-emerald-100 text-emerald-700"}
        >
          {vendor.archivedAt ? "Archived" : "Active"}
        </Badge>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !canArchive}
          onclick={toggleArchived}
        >
          {vendor.archivedAt ? "Restore" : "Archive"}
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
        You have read-only access to vendors — editing is disabled.
      </p>
    {/if}

    <!-- Details -->
    <section class="space-y-4 rounded-lg border bg-card p-5">
      <h2 class="text-sm font-semibold">Details</h2>
      <div class="grid grid-cols-2 gap-4">
        <label class="space-y-1">
          <span class="text-sm font-medium">Name</span>
          <Input bind:value={form.name} disabled={!canEdit} />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Phone</span>
          <Input bind:value={form.phone} disabled={!canEdit} />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Email</span>
          <Input bind:value={form.email} disabled={!canEdit} />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Tax ID</span>
          <Input bind:value={form.taxId} disabled={!canEdit} />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Lead time (days)</span>
          <Input
            type="number"
            bind:value={form.leadTimeDays}
            disabled={!canEdit}
          />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Preferred send channel</span>
          <Select
            bind:value={form.preferredSendChannel}
            disabled={!canEdit}
          >
            {#each CHANNELS as c (c)}
              <option value={c}>{c === "" ? "— No preference —" : c}</option>
            {/each}
          </Select>
        </label>
      </div>
      <label class="space-y-1">
        <span class="text-sm font-medium">Address</span>
        <Input bind:value={form.address} disabled={!canEdit} />
      </label>
      <label class="space-y-1">
        <span class="text-sm font-medium">Notes</span>
        <Textarea
          bind:value={form.notes}
          disabled={!canEdit}
          class="h-20 resize-none"
        />
      </label>
      <div class="flex justify-end">
        <Button disabled={busy || !canEdit} onclick={saveVendor}>
          Save details
        </Button>
      </div>
    </section>

    <!-- AP balance -->
    <section class="space-y-4 rounded-lg border bg-card p-5">
      <h2 class="text-sm font-semibold">Accounts payable</h2>

      {#if canRecordPayment}
        <div class="space-y-2">
          <h3 class="text-xs font-medium text-muted-foreground">
            Record a payment
          </h3>
          <div class="flex items-end gap-2">
            <label class="space-y-1">
              <span class="text-xs font-medium">Amount (minor units)</span>
              <Input type="number" bind:value={payAmount} class="w-40" />
            </label>
            <label class="flex-1 space-y-1">
              <span class="text-xs font-medium">Note (optional)</span>
              <Input bind:value={payNote} />
            </label>
            <Button
              size="sm"
              disabled={busy || !payAmount || payAmount <= 0}
              onclick={recordPayment}>Record payment</Button
            >
          </div>
        </div>
      {/if}

      {#if canAdjust}
        <div class="space-y-2">
          <h3 class="text-xs font-medium text-muted-foreground">
            Manual balance adjustment
          </h3>
          <div class="flex items-end gap-2">
            <label class="space-y-1">
              <span class="text-xs font-medium">
                Signed amount (minor units)
              </span>
              <Input type="number" bind:value={adjAmount} class="w-40" />
            </label>
            <label class="flex-1 space-y-1">
              <span class="text-xs font-medium">Note (required)</span>
              <Input bind:value={adjNote} />
            </label>
            <Button
              size="sm"
              disabled={busy || !adjAmount || !adjNote.trim()}
              onclick={adjustBalance}>Adjust</Button
            >
          </div>
          <p class="text-xs text-muted-foreground">
            Positive raises what we owe; negative lowers it.
          </p>
        </div>
      {/if}

      {#if !canRecordPayment && !canAdjust}
        <p class="text-sm text-muted-foreground">
          You don't have permission to record payments or adjustments.
        </p>
      {/if}
    </section>

    <!-- Ledger -->
    {#if canViewLedger}
      <section class="space-y-3 rounded-lg border bg-card p-5">
        <h2 class="text-sm font-semibold">AP ledger ({ledger.length})</h2>
        {#if $VendorLedger.fetching && ledger.length === 0}
          <p class="text-sm text-muted-foreground">Loading…</p>
        {:else}
          <table class="w-full text-sm">
            <thead class="border-b text-left text-muted-foreground">
              <tr>
                <th class="py-1.5 font-medium">When</th>
                <th class="py-1.5 font-medium">Type</th>
                <th class="py-1.5 text-right font-medium">Amount</th>
                <th class="py-1.5 font-medium">Note</th>
              </tr>
            </thead>
            <tbody>
              {#each ledger as e (e.id)}
                <tr class="border-b last:border-0">
                  <td class="py-1.5">{fmtDateTime(e.createdAt)}</td>
                  <td class="py-1.5">{e.type}</td>
                  <td
                    class="py-1.5 text-right {e.amountMinor < 0
                      ? 'text-emerald-700'
                      : ''}"
                  >
                    {formatMoney(e.amountMinor)}
                  </td>
                  <td class="py-1.5 text-muted-foreground">{e.note ?? "—"}</td>
                </tr>
              {/each}
              {#if ledger.length === 0}
                <tr>
                  <td colspan="4" class="py-6 text-center text-muted-foreground">
                    No ledger entries.
                  </td>
                </tr>
              {/if}
            </tbody>
          </table>
        {/if}
      </section>
    {/if}

    <!-- Danger zone -->
    {#if canHardDelete}
      <section class="space-y-2 rounded-lg border border-destructive/30 p-5">
        <h2 class="text-sm font-semibold text-destructive">Danger zone</h2>
        <p class="text-sm text-muted-foreground">
          Permanently delete this vendor. Refused by the API if it carries a
          non-zero AP balance.
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || vendor.balanceMinor !== 0}
          onclick={hardDelete}
        >
          Delete vendor
        </Button>
        {#if vendor.balanceMinor !== 0}
          <p class="text-xs text-muted-foreground">
            Clear the AP balance first.
          </p>
        {/if}
      </section>
    {/if}
  {/if}
</div>
