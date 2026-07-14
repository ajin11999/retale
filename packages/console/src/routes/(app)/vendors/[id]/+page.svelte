<script lang="ts">
  import NumericInput from "$lib/components/ui/numeric-input.svelte";
  import { CachePolicy, graphql } from "$houdini";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import type { Viewer } from "../../+layout.server";
  import { formatMoney, statusLabel } from "$lib/utils";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Combobox from "$lib/components/ui/combobox.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import MoneyInput from "$lib/components/ui/money-input.svelte";
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
        kind
        phone
        email
        address
        taxId
        notes
        leadTimeDays
        paymentTermsDays
        preferredSendChannel
        defaultShipToAddressId
        balanceMinor
        archivedAt
      }
    }
  `);

  // Our ship-to addresses, for the default-ship-to picker. Uses the
  // vendor.edit-gated `shipToAddresses` query so a clerk can pick one without
  // settings access; fetched lazily (bundling it into VendorDetail is
  // unnecessary and keeps the read off viewers who can't edit).
  const ShipToAddresses = graphql(`
    query ConsoleShipToAddresses {
      shipToAddresses {
        id
        label
        isDefault
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
        dueDate
        note
        createdAt
      }
    }
  `);

  const UpdateVendor = graphql(`
    mutation ConsoleUpdateVendor(
      $id: ID!
      $name: String
      $kind: VendorKind
      $phone: String
      $email: String
      $address: String
      $taxId: String
      $notes: String
      $leadTimeDays: Int
      $paymentTermsDays: Int
      $preferredSendChannel: VendorSendChannel
      $defaultShipToAddressId: ID
    ) {
      updateVendor(
        id: $id
        name: $name
        kind: $kind
        phone: $phone
        email: $email
        address: $address
        taxId: $taxId
        notes: $notes
        leadTimeDays: $leadTimeDays
        paymentTermsDays: $paymentTermsDays
        preferredSendChannel: $preferredSendChannel
        defaultShipToAddressId: $defaultShipToAddressId
      ) {
        id
        name
        kind
        phone
        email
        address
        taxId
        notes
        leadTimeDays
        paymentTermsDays
        preferredSendChannel
        defaultShipToAddressId
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

  // Variant codes are a separate document so it can be fetched lazily — only
  // for viewers with vendor.variant_code.manage, which is the same key the
  // mutations require. The variant catalogue is loaded alongside so the add
  // form can render a picker.
  const VendorCodes = graphql(`
    query ConsoleVendorCodes($vendorId: ID!) {
      codesForVendor(vendorId: $vendorId) {
        id
        variantId
        code
        isPreferred
        updatedAt
        variant {
          id
          sku
          label
          unit
        }
      }
      products(includeArchived: false) {
        id
        name
        variants {
          id
          sku
          label
        }
      }
    }
  `);

  const SetVendorVariantCode = graphql(`
    mutation ConsoleSetVendorVariantCode(
      $vendorId: ID!
      $variantId: ID!
      $code: String!
      $isPreferred: Boolean
    ) {
      setVendorVariantCode(
        vendorId: $vendorId
        variantId: $variantId
        code: $code
        isPreferred: $isPreferred
      ) {
        id
      }
    }
  `);

  const DeleteVendorVariantCode = graphql(`
    mutation ConsoleDeleteVendorVariantCode($id: ID!) {
      deleteVendorVariantCode(id: $id)
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
  const canManageCodes = $derived(has("vendor.variant_code.manage"));
  const canPickShipTo = $derived(canEdit);
  const canManageAddresses = $derived(has("admin.settings.manage"));

  // ---- Header form ---------------------------------------------------------
  const CHANNELS = ["", "whatsapp", "email"];
  const KINDS = ["supplier", "expedition"];
  interface VendorForm {
    name: string;
    kind: string;
    phone: string;
    email: string;
    address: string;
    taxId: string;
    notes: string;
    leadTimeDays: number | null;
    paymentTermsDays: number | null;
    preferredSendChannel: string;
    defaultShipToAddressId: string;
  }
  let form = $state<VendorForm>({
    name: "",
    kind: "supplier",
    phone: "",
    email: "",
    address: "",
    taxId: "",
    notes: "",
    leadTimeDays: null,
    paymentTermsDays: null,
    preferredSendChannel: "",
    defaultShipToAddressId: "",
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
        kind: v.kind,
        phone: v.phone ?? "",
        email: v.email ?? "",
        address: v.address ?? "",
        taxId: v.taxId ?? "",
        notes: v.notes ?? "",
        leadTimeDays: v.leadTimeDays ?? null,
        paymentTermsDays: v.paymentTermsDays ?? null,
        preferredSendChannel: v.preferredSendChannel ?? "",
        defaultShipToAddressId: v.defaultShipToAddressId ?? "",
      };
    }
  });

  // Load the address book once, for viewers who can pick a ship-to.
  let addressesLoaded = $state(false);
  $effect(() => {
    if (vendor && canPickShipTo && !addressesLoaded) {
      addressesLoaded = true;
      ShipToAddresses.fetch();
    }
  });
  const shipToAddresses = $derived($ShipToAddresses.data?.shipToAddresses ?? []);

  // Load the ledger once, for viewers allowed to see it.
  let ledgerLoaded = $state(false);
  $effect(() => {
    if (vendor && canViewLedger && !ledgerLoaded) {
      ledgerLoaded = true;
      VendorLedger.fetch({ variables: { vendorId: vendor.id } });
    }
  });
  const ledger = $derived($VendorLedger.data?.vendorLedger ?? []);

  // Same lazy pattern for the variant-code panel — fetched once when a
  // permitted viewer lands on the page.
  let codesLoaded = $state(false);
  $effect(() => {
    if (vendor && canManageCodes && !codesLoaded) {
      codesLoaded = true;
      VendorCodes.fetch({ variables: { vendorId: vendor.id } });
    }
  });
  const codes = $derived($VendorCodes.data?.codesForVendor ?? []);
  const allProducts = $derived($VendorCodes.data?.products ?? []);
  // Variants the vendor doesn't already have a code for — keeps the add
  // form from offering rows that would just upsert an existing row.
  const mappedVariantIds = $derived(new Set(codes.map((c) => c.variantId)));
  type VariantOption = {
    id: string;
    label: string;
    productName: string;
  };
  const availableVariants = $derived.by((): VariantOption[] => {
    const out: VariantOption[] = [];
    for (const p of allProducts) {
      for (const v of p.variants) {
        if (mappedVariantIds.has(v.id)) continue;
        const label = v.label ? `${v.sku} · ${v.label}` : v.sku;
        out.push({ id: v.id, label, productName: p.name });
      }
    }
    return out.sort((a, b) =>
      a.productName.localeCompare(b.productName) || a.label.localeCompare(b.label),
    );
  });
  // { value, label } shape for the searchable Combobox.
  const availableVariantOptions = $derived(
    availableVariants.map((v) => ({
      value: v.id,
      label: `${v.productName} — ${v.label}`,
    })),
  );

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
      // NetworkOnly — a payment/adjustment adds a ledger row the mutation
      // result doesn't carry, so the cached list would otherwise stay stale.
      await VendorLedger.fetch({
        variables: { vendorId: vendor.id },
        policy: CachePolicy.NetworkOnly,
      });
    }
  };

  async function saveVendor() {
    if (!vendor) return;
    await run("Vendor", () =>
      UpdateVendor.mutate({
        id: vendor.id,
        name: form.name.trim(),
        kind: (form.kind || "supplier") as never,
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        address: form.address.trim() || null,
        taxId: form.taxId.trim() || null,
        notes: form.notes.trim() || null,
        leadTimeDays: form.leadTimeDays,
        paymentTermsDays: form.paymentTermsDays,
        preferredSendChannel: (form.preferredSendChannel || null) as never,
        defaultShipToAddressId: form.defaultShipToAddressId || null,
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

  // ---- Pay by selecting charges -------------------------------------------
  // AP is a running balance, so individual charges can't be flagged settled.
  // Instead, ticking outstanding charges sums them into a single payment for
  // their exact total. Selectable rows are debits (positive amount) — the
  // things we owe; payments and credits (negative) aren't selectable.
  let selectedCharges = $state<Set<string>>(new Set());
  const selectableLedger = $derived(ledger.filter((e) => e.amountMinor > 0));
  const selectedCount = $derived(selectedCharges.size);
  const selectedTotal = $derived(
    selectableLedger
      .filter((e) => selectedCharges.has(e.id))
      .reduce((sum, e) => sum + e.amountMinor, 0),
  );

  // Drop selections whose rows vanished after a refetch.
  $effect(() => {
    const live = new Set(selectableLedger.map((e) => e.id));
    if ([...selectedCharges].some((id) => !live.has(id)))
      selectedCharges = new Set(
        [...selectedCharges].filter((id) => live.has(id)),
      );
  });

  function toggleCharge(id: string) {
    const next = new Set(selectedCharges);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedCharges = next;
  }
  const allChargesChecked = $derived(
    selectableLedger.length > 0 &&
      selectableLedger.every((e) => selectedCharges.has(e.id)),
  );
  function toggleAllCharges() {
    selectedCharges = allChargesChecked
      ? new Set()
      : new Set(selectableLedger.map((e) => e.id));
  }
  const clearCharges = () => (selectedCharges = new Set());

  async function paySelectedCharges() {
    if (!vendor || selectedCount === 0 || selectedTotal <= 0) return;
    const rows = selectableLedger.filter((e) => selectedCharges.has(e.id));
    const dues = rows
      .map((r) => r.dueDate)
      .filter((d): d is string => !!d)
      .sort();
    const range =
      dues.length === 0
        ? ""
        : dues[0] === dues[dues.length - 1]
          ? ` (due ${dues[0]})`
          : ` (due ${dues[0]}…${dues[dues.length - 1]})`;
    const note = `Payment for ${selectedCount} charge${
      selectedCount === 1 ? "" : "s"
    }${range}`;
    if (
      !confirm(
        `Record a payment of ${formatMoney(selectedTotal)} for ${selectedCount} selected charge${
          selectedCount === 1 ? "" : "s"
        }?`,
      )
    )
      return;
    const ok = await run("Payment", () =>
      RecordVendorPayment.mutate({
        vendorId: vendor.id,
        amountMinor: selectedTotal,
        note,
      }),
    );
    if (ok) {
      clearCharges();
      await refetch();
    }
  }

  let adjAmount = $state<number | null>(null);
  let adjNote = $state("");

  // ---- Variant code form --------------------------------------------------
  let codeVariantId = $state("");
  let codeText = $state("");
  let codePreferred = $state(false);

  async function addCode() {
    if (!vendor || !codeVariantId || !codeText.trim()) return;
    const ok = await run("Code", () =>
      SetVendorVariantCode.mutate({
        vendorId: vendor.id,
        variantId: codeVariantId,
        code: codeText.trim(),
        isPreferred: codePreferred,
      }),
    );
    if (ok) {
      codeVariantId = "";
      codeText = "";
      codePreferred = false;
      await VendorCodes.fetch({ policy: CachePolicy.NetworkOnly, variables: { vendorId: vendor.id } });
    }
  }

  async function togglePreferred(c: (typeof codes)[number]) {
    if (!vendor) return;
    const ok = await run("Code", () =>
      SetVendorVariantCode.mutate({
        vendorId: vendor.id,
        variantId: c.variantId,
        code: c.code,
        isPreferred: !c.isPreferred,
      }),
    );
    if (ok) await VendorCodes.fetch({ policy: CachePolicy.NetworkOnly, variables: { vendorId: vendor.id } });
  }

  async function removeCode(id: string) {
    if (!vendor || !confirm("Remove this vendor code mapping?")) return;
    const ok = await run("Code", () =>
      DeleteVendorVariantCode.mutate({ id }),
    );
    if (ok) await VendorCodes.fetch({ policy: CachePolicy.NetworkOnly, variables: { vendorId: vendor.id } });
  }

  // ---- Bulk variant code form ---------------------------------------------
  let bulkDialog = $state<HTMLDialogElement>();
  let bulkSearch = $state("");
  let bulkCodes = $state<Record<string, string>>({});
  let bulkBusy = $state(false);

  const bulkFilteredVariants = $derived(
    availableVariants.filter(
      (v) =>
        !bulkSearch ||
        v.label.toLowerCase().includes(bulkSearch.toLowerCase()) ||
        v.productName.toLowerCase().includes(bulkSearch.toLowerCase()),
    ),
  );

  function openBulkDialog() {
    bulkSearch = "";
    bulkCodes = {};
    bulkDialog?.showModal();
  }

  function closeBulkDialog() {
    bulkDialog?.close();
  }

  async function saveBulkCodes() {
    if (!vendor) return;
    const entries = Object.entries(bulkCodes).filter(
      ([_, code]) => code.trim() !== "",
    );
    if (entries.length === 0) {
      closeBulkDialog();
      return;
    }
    bulkBusy = true;
    try {
      await Promise.all(
        entries.map(([variantId, code]) =>
          SetVendorVariantCode.mutate({
            vendorId: vendor.id,
            variantId,
            code: code.trim(),
            isPreferred: false,
          }),
        ),
      );
      await VendorCodes.fetch({
        policy: CachePolicy.NetworkOnly,
        variables: { vendorId: vendor.id },
      });
      closeBulkDialog();
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
    } finally {
      bulkBusy = false;
    }
  }

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
          <span class="text-sm font-medium">Kind</span>
          <Select bind:value={form.kind} disabled={!canEdit}>
            {#each KINDS as k (k)}
              <option value={k}>{k === "expedition" ? "Expedition / courier" : "Supplier"}</option>
            {/each}
          </Select>
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
          <NumericInput
            bind:value={form.leadTimeDays}
            disabled={!canEdit}
          />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Payment terms (days)</span>
          <NumericInput
            bind:value={form.paymentTermsDays}
            disabled={!canEdit}
          />
          <span class="text-xs text-muted-foreground">
            Net days from receipt; sets each charge's AP due date.
          </span>
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
      <!-- `block` matters on these section-level labels: a bare <label> is
           inline, so consecutive ones would flow onto the same line. -->
      <label class="block space-y-1">
        <span class="text-sm font-medium">Address</span>
        <Input bind:value={form.address} disabled={!canEdit} />
      </label>
      {#if canPickShipTo}
        <label class="block space-y-1">
          <span class="text-sm font-medium">Default ship-to (our address)</span>
          <Select bind:value={form.defaultShipToAddressId} disabled={!canEdit}>
            <option value="">— Use default address —</option>
            {#each shipToAddresses as a (a.id)}
              <option value={a.id}>{a.label}{a.isDefault ? " (default)" : ""}</option>
            {/each}
          </Select>
          <span class="text-xs text-muted-foreground">
            Printed as “Ship To” on this vendor's purchase orders.
            {#if canManageAddresses}
              <a href="/settings/addresses" class="underline">Manage addresses</a>
            {/if}
          </span>
        </label>
      {/if}
      <label class="block space-y-1">
        <span class="text-sm font-medium">Notes</span>
        <Textarea
          bind:value={form.notes}
          disabled={!canEdit}
          class="h-20 resize-none"
        />
      </label>
      <div class="flex justify-end pt-2">
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
              <span class="text-xs font-medium">Amount (Rp)</span>
              <MoneyInput bind:value={payAmount} class="w-40" />
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
              <span class="text-xs font-medium">Signed amount (Rp)</span>
              <MoneyInput allowNegative bind:value={adjAmount} class="w-40" />
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
        {#if canRecordPayment && selectableLedger.length > 0}
          <p class="text-xs text-muted-foreground">
            Tick outstanding charges to pay their total in one payment. AP is a
            running balance, so charges aren't individually marked paid.
          </p>
        {/if}
        {#if $VendorLedger.fetching && ledger.length === 0}
          <p class="text-sm text-muted-foreground">Loading…</p>
        {:else}
          <table class="w-full text-sm">
            <thead class="border-b text-left text-muted-foreground">
              <tr>
                {#if canRecordPayment}
                  <th class="w-8 py-1.5">
                    <input
                      type="checkbox"
                      aria-label="Select all charges"
                      checked={allChargesChecked}
                      disabled={busy || selectableLedger.length === 0}
                      onchange={toggleAllCharges}
                    />
                  </th>
                {/if}
                <th class="py-1.5 pr-4 font-medium">When</th>
                <th class="py-1.5 pr-4 font-medium">Type</th>
                <th class="py-1.5 text-right font-medium">Amount</th>
                <th class="py-1.5 pl-4 font-medium">Due</th>
                <th class="py-1.5 pl-4 font-medium">Note</th>
              </tr>
            </thead>
            <tbody>
              {#each ledger as e (e.id)}
                <tr
                  class="border-b last:border-0 {selectedCharges.has(e.id)
                    ? 'bg-primary/5'
                    : ''}"
                >
                  {#if canRecordPayment}
                    <td class="py-1.5">
                      {#if e.amountMinor > 0}
                        <input
                          type="checkbox"
                          aria-label="Select charge"
                          checked={selectedCharges.has(e.id)}
                          disabled={busy}
                          onchange={() => toggleCharge(e.id)}
                        />
                      {/if}
                    </td>
                  {/if}
                  <td class="py-1.5 pr-4">{fmtDateTime(e.createdAt)}</td>
                  <td class="py-1.5 pr-4">{statusLabel(e.type)}</td>
                  <td
                    class="py-1.5 text-right {e.amountMinor < 0
                      ? 'text-emerald-700'
                      : ''}"
                  >
                    {formatMoney(e.amountMinor)}
                  </td>
                  <td class="py-1.5 pl-4 text-muted-foreground">{e.dueDate ?? "—"}</td>
                  <td class="py-1.5 pl-4 text-muted-foreground">{e.note ?? "—"}</td>
                </tr>
              {/each}
              {#if ledger.length === 0}
                <tr>
                  <td
                    colspan={canRecordPayment ? 6 : 5}
                    class="py-6 text-center text-muted-foreground"
                  >
                    No ledger entries.
                  </td>
                </tr>
              {/if}
            </tbody>
          </table>

          {#if canRecordPayment && selectedCount > 0}
            <div
              class="flex items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2"
            >
              <span class="text-sm">
                {selectedCount} charge{selectedCount === 1 ? "" : "s"} selected ·
                <span class="font-medium">{formatMoney(selectedTotal)}</span>
              </span>
              <div class="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onclick={clearCharges}>Clear</Button
                >
                <Button
                  size="sm"
                  disabled={busy || selectedTotal <= 0}
                  onclick={paySelectedCharges}>Pay selected</Button
                >
              </div>
            </div>
          {/if}
        {/if}
      </section>
    {/if}

    <!-- Vendor variant codes -->
    {#if canManageCodes}
      <section class="space-y-3 rounded-lg border bg-card p-5">
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-semibold">
            Vendor variant codes ({codes.length})
          </h2>
          <Button variant="outline" size="sm" onclick={openBulkDialog}>
            Bulk map…
          </Button>
        </div>
        <p class="text-xs text-muted-foreground">
          The vendor's own part numbers for our variants — fed into the
          receiving scan and the reorder forecast.
        </p>

        {#if $VendorCodes.fetching && codes.length === 0}
          <p class="text-sm text-muted-foreground">Loading…</p>
        {:else}
          <table class="w-full text-sm">
            <thead class="border-b text-left text-muted-foreground">
              <tr>
                <th class="py-1.5 font-medium">Variant</th>
                <th class="py-1.5 font-medium">Vendor code</th>
                <th class="py-1.5 font-medium">Preferred</th>
                <th class="py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {#each codes as c (c.id)}
                <tr class="border-b last:border-0">
                  <td class="py-1.5">
                    {#if c.variant}
                      <span class="font-mono text-xs">{c.variant.sku}</span>
                      {#if c.variant.label}
                        <span class="ml-1 text-xs text-muted-foreground">
                          {c.variant.label}
                        </span>
                      {/if}
                    {:else}
                      <span class="font-mono text-xs text-muted-foreground">
                        {c.variantId.slice(-8)}
                      </span>
                    {/if}
                  </td>
                  <td class="py-1.5 font-mono text-xs">{c.code}</td>
                  <td class="py-1.5">
                    <label class="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={c.isPreferred}
                        disabled={busy}
                        onchange={() => togglePreferred(c)}
                      />
                      {#if c.isPreferred}
                        <Badge class="bg-primary/10 text-primary">preferred</Badge>
                      {/if}
                    </label>
                  </td>
                  <td class="py-1.5 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      class="text-destructive"
                      disabled={busy}
                      onclick={() => removeCode(c.id)}>Remove</Button
                    >
                  </td>
                </tr>
              {/each}
              {#if codes.length === 0}
                <tr>
                  <td colspan="4" class="py-6 text-center text-muted-foreground">
                    No vendor codes mapped yet.
                  </td>
                </tr>
              {/if}
            </tbody>
          </table>

          <div class="rounded-md border bg-muted/40 p-3">
            <p class="mb-2 text-xs font-medium">Add a mapping</p>
            <div class="grid grid-cols-[1fr_10rem_auto_auto] items-end gap-2">
              <label class="space-y-1">
                <span class="text-xs font-medium">Variant</span>
                <Combobox
                  options={availableVariantOptions}
                  bind:value={codeVariantId}
                  placeholder="Search variant…"
                />
              </label>
              <label class="space-y-1">
                <span class="text-xs font-medium">Vendor code</span>
                <Input bind:value={codeText} placeholder="e.g. ABC-1234" />
              </label>
              <label class="flex items-center gap-1 pb-2 text-xs">
                <input type="checkbox" bind:checked={codePreferred} />
                Preferred
              </label>
              <Button
                size="sm"
                disabled={busy || !codeVariantId || !codeText.trim()}
                onclick={addCode}>Add</Button
              >
            </div>
            {#if availableVariants.length === 0 && allProducts.length > 0}
              <p class="mt-2 text-xs text-muted-foreground">
                Every variant already has a code for this vendor.
              </p>
            {/if}
          </div>
        {/if}

        <dialog
          bind:this={bulkDialog}
          class="m-auto w-full max-w-2xl rounded-lg border bg-background p-0 shadow-lg backdrop:bg-black/50"
          onclose={() => {
            bulkSearch = "";
            bulkCodes = {};
          }}
        >
          <div class="flex h-[80vh] max-h-[600px] flex-col">
            <div class="border-b p-4">
              <h3 class="text-lg font-semibold">Bulk map variant codes</h3>
              <p class="mt-1 text-sm text-muted-foreground">
                Search for variants and enter vendor codes. Empty fields will be
                ignored.
              </p>
              <div class="mt-4">
                <Input
                  bind:value={bulkSearch}
                  placeholder="Search variants…"
                  type="search"
                />
              </div>
            </div>

            <div class="flex-1 space-y-2 overflow-y-auto p-4">
              {#each bulkFilteredVariants as v (v.id)}
                <div
                  class="flex items-center gap-4 border-b pb-2 last:border-0 last:pb-0"
                >
                  <div class="flex-1">
                    <p class="text-sm font-medium">{v.productName}</p>
                    <p class="text-xs text-muted-foreground">{v.label}</p>
                  </div>
                  <div class="w-48">
                    <Input
                      bind:value={bulkCodes[v.id]}
                      placeholder="Vendor code"
                      disabled={bulkBusy}
                    />
                  </div>
                </div>
              {:else}
                <p class="py-4 text-center text-sm text-muted-foreground">
                  No variants match your search.
                </p>
              {/each}
            </div>

            <div class="flex justify-end gap-2 border-t bg-muted/40 p-4">
              <Button
                variant="ghost"
                disabled={bulkBusy}
                onclick={closeBulkDialog}>Cancel</Button
              >
              <Button disabled={bulkBusy} onclick={saveBulkCodes}>
                {bulkBusy ? "Saving…" : "Save mappings"}
              </Button>
            </div>
          </div>
        </dialog>
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
