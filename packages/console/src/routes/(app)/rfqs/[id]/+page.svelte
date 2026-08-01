<script lang="ts">
  import { graphql } from "$houdini";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import type { Viewer } from "../../+layout.server";
  import { formatMoney } from "$lib/utils";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Combobox from "$lib/components/ui/combobox.svelte";
  import IconButton from "$lib/components/ui/icon-button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import MoneyInput from "$lib/components/ui/money-input.svelte";
  import NumericInput from "$lib/components/ui/numeric-input.svelte";
  import Select from "$lib/components/ui/select.svelte";
  import Textarea from "$lib/components/ui/textarea.svelte";
  import {
    Pencil,
    Printer,
    Trash2,
    ArrowRight,
  } from "@lucide/svelte";
  import type { PageData } from "./$types";

  graphql(`
    query RfqDetail($id: ID!) {
      rfq(id: $id) {
        id
        rfqNumber
        vendorId
        snapshotVendorName
        date
        dueDate
        status
        memo
        termsAndConditions
        createdAt
        updatedAt
        sections {
          id
          name
          sortOrder
        }
        items {
          id
          sectionId
          requisitionItemId
          variantId
          description
          qtyRequested
          targetUnitCostMinor
          quotedUnitCostMinor
          sortOrder
        }
      }
    }
  `);

  graphql(`
    query RfqEditorRefData {
      vendors {
        id
        name
      }
      products(includeArchived: true) {
        id
        name
        kind
        variants {
          id
          sku
          label
          costMinor
        }
      }
    }
  `);

  const UpdateRfq = graphql(`
    mutation ConsoleUpdateRfq(
      $id: ID!
      $vendorId: ID
      $date: String
      $dueDate: String
      $status: RfqStatus
      $memo: String
      $termsAndConditions: String
    ) {
      updateRfq(
        id: $id
        vendorId: $vendorId
        date: $date
        dueDate: $dueDate
        status: $status
        memo: $memo
        termsAndConditions: $termsAndConditions
      ) {
        id
        vendorId
        snapshotVendorName
        date
        dueDate
        status
        memo
        termsAndConditions
      }
    }
  `);

  const DeleteRfq = graphql(`
    mutation ConsoleDeleteRfq($id: ID!) {
      deleteRfq(id: $id)
    }
  `);

  const CreateSection = graphql(`
    mutation ConsoleCreateRfqSection($rfqId: ID!, $name: String!) {
      createRfqSection(rfqId: $rfqId, name: $name) {
        id
      }
    }
  `);

  const UpdateSection = graphql(`
    mutation ConsoleUpdateRfqSection($id: ID!, $name: String!) {
      updateRfqSection(id: $id, name: $name) {
        id
        name
      }
    }
  `);

  const DeleteSection = graphql(`
    mutation ConsoleDeleteRfqSection($id: ID!) {
      deleteRfqSection(id: $id)
    }
  `);

  const CreateItem = graphql(`
    mutation ConsoleCreateRfqItem(
      $rfqId: ID!
      $sectionId: ID
      $variantId: ID
      $description: String
      $qtyRequested: Float!
      $targetUnitCostMinor: Float
      $quotedUnitCostMinor: Float
    ) {
      createRfqItem(
        rfqId: $rfqId
        sectionId: $sectionId
        variantId: $variantId
        description: $description
        qtyRequested: $qtyRequested
        targetUnitCostMinor: $targetUnitCostMinor
        quotedUnitCostMinor: $quotedUnitCostMinor
      ) {
        id
      }
    }
  `);

  const UpdateItem = graphql(`
    mutation ConsoleUpdateRfqItem(
      $id: ID!
      $sectionId: ID
      $variantId: ID
      $description: String
      $qtyRequested: Float
      $targetUnitCostMinor: Float
      $quotedUnitCostMinor: Float
    ) {
      updateRfqItem(
        id: $id
        sectionId: $sectionId
        variantId: $variantId
        description: $description
        qtyRequested: $qtyRequested
        targetUnitCostMinor: $targetUnitCostMinor
        quotedUnitCostMinor: $quotedUnitCostMinor
      ) {
        id
        sectionId
        variantId
        description
        qtyRequested
        targetUnitCostMinor
        quotedUnitCostMinor
      }
    }
  `);

  const DeleteItem = graphql(`
    mutation ConsoleDeleteItem($id: ID!) {
      deleteRfqItem(id: $id)
    }
  `);

  const ConvertRfqToPurchase = graphql(`
    mutation ConsoleConvertRfqToPurchase($rfqId: ID!, $vendorId: ID) {
      convertRfqToPurchase(rfqId: $rfqId, vendorId: $vendorId) {
        id
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const RfqDetail = $derived(data.RfqDetail);
  const RefData = $derived(data.RfqEditorRefData);

  const rfq = $derived($RfqDetail.data?.rfq);
  const vendors = $derived($RefData.data?.vendors ?? []);
  const products = $derived(
    ($RefData.data?.products ?? []).filter((p: any) => p.kind !== "bundle")
  );

  const vendorOptions = $derived([
    { value: "", label: "— Unspecified Vendor —" },
    ...vendors.map((v: any) => ({ value: v.id, label: v.name })),
  ]);

  interface VariantOption {
    value: string;
    label: string;
  }

  const variantOptions = $derived.by<VariantOption[]>(() => {
    const out: VariantOption[] = [];
    for (const p of products) {
      for (const v of p.variants) {
        const suffix = v.label ? `${v.sku} · ${v.label}` : v.sku;
        out.push({ value: v.id, label: `${p.name} · ${suffix}` });
      }
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  });

  const variantLabel = (id: string | null | undefined) =>
    id ? variantOptions.find((v) => v.value === id)?.label ?? "Unknown" : null;

  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canEdit = $derived(has("purchase.edit"));

  const isEditable = $derived(
    canEdit && rfq?.status !== "awarded" && rfq?.status !== "cancelled"
  );

  // ---- Form state ----
  interface HeaderForm {
    vendorId: string;
    date: string;
    dueDate: string;
    status: string;
    memo: string;
    termsAndConditions: string;
  }

  let form = $state<HeaderForm>({
    vendorId: "",
    date: "",
    dueDate: "",
    status: "draft",
    memo: "",
    termsAndConditions: "",
  });

  let syncedId = $state("");
  $effect(() => {
    const r = rfq;
    if (r && r.id !== syncedId) {
      syncedId = r.id;
      form = {
        vendorId: r.vendorId ?? "",
        date: r.date ?? "",
        dueDate: r.dueDate ?? "",
        status: r.status,
        memo: r.memo ?? "",
        termsAndConditions: r.termsAndConditions ?? "",
      };
    }
  });

  let busy = $state(false);
  let feedback = $state<{ ok: boolean; text: string } | null>(null);

  const refetch = () => {
    return (
      rfq &&
      RfqDetail.fetch({ variables: { id: rfq.id }, policy: "NetworkOnly" })
    );
  };

  async function saveHeader() {
    if (!rfq) return;
    busy = true;
    feedback = null;
    try {
      const res = await UpdateRfq.mutate({
        id: rfq.id,
        vendorId: form.vendorId || null,
        date: form.date,
        dueDate: form.dueDate || null,
        status: form.status as any,
        memo: form.memo.trim() || null,
        termsAndConditions: form.termsAndConditions.trim() || null,
      });
      if (res.errors?.length) {
        feedback = { ok: false, text: res.errors[0].message };
      } else {
        feedback = { ok: true, text: "RFQ header updated." };
        await refetch();
      }
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
    } finally {
      busy = false;
    }
  }

  async function setStatus(nextStatus: "draft" | "sent" | "received" | "cancelled") {
    if (!rfq) return;
    form.status = nextStatus;
    await saveHeader();
  }

  async function convertToPO() {
    if (!rfq) return;
    if (
      !confirm(
        `Convert RFQ ${rfq.rfqNumber} to a Purchase Order? This will mark the RFQ as awarded.`
      )
    )
      return;

    busy = true;
    feedback = null;
    try {
      const res = await ConvertRfqToPurchase.mutate({
        rfqId: rfq.id,
        vendorId: form.vendorId || null,
      });
      if (res.errors?.length) {
        feedback = { ok: false, text: res.errors[0].message };
      } else {
        const poId = res.data?.convertRfqToPurchase.id;
        if (poId) {
          await goto(`/purchases/${poId}`);
        }
      }
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
    } finally {
      busy = false;
    }
  }

  async function deleteRfq() {
    if (!rfq || !confirm(`Delete RFQ ${rfq.rfqNumber}? This action cannot be undone.`))
      return;
    busy = true;
    try {
      const res = await DeleteRfq.mutate({ id: rfq.id });
      if (res.errors?.length) {
        feedback = { ok: false, text: res.errors[0].message };
      } else {
        await goto("/rfqs");
      }
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
    } finally {
      busy = false;
    }
  }

  // ---- Sections ----
  let newSectionName = $state<string | null>(null);

  async function addSection() {
    const name = (newSectionName ?? "").trim();
    if (!rfq || !name) return;
    busy = true;
    try {
      const res = await CreateSection.mutate({ rfqId: rfq.id, name });
      if (!res.errors?.length) {
        newSectionName = null;
        await refetch();
      }
    } finally {
      busy = false;
    }
  }

  // ---- Items ----
  interface ItemDraft {
    id: string | null;
    sectionId: string;
    variantId: string;
    description: string;
    qtyRequested: number;
    targetUnitCostMinor: number;
    quotedUnitCostMinor: number;
  }

  let itemDraft = $state<ItemDraft | null>(null);

  function startAddItem(sectionId: string = "") {
    itemDraft = {
      id: null,
      sectionId,
      variantId: "",
      description: "",
      qtyRequested: 1,
      targetUnitCostMinor: 0,
      quotedUnitCostMinor: 0,
    };
  }

  function startEditItem(i: NonNullable<typeof rfq>["items"][number]) {
    itemDraft = {
      id: i.id,
      sectionId: i.sectionId ?? "",
      variantId: i.variantId ?? "",
      description: i.description ?? "",
      qtyRequested: i.qtyRequested,
      targetUnitCostMinor: i.targetUnitCostMinor,
      quotedUnitCostMinor: i.quotedUnitCostMinor,
    };
  }

  async function saveItem() {
    const d = itemDraft;
    if (!d || !rfq) return;

    busy = true;
    try {
      if (d.id) {
        const res = await UpdateItem.mutate({
          id: d.id,
          sectionId: d.sectionId || null,
          variantId: d.variantId || null,
          description: d.description.trim() || null,
          qtyRequested: d.qtyRequested,
          targetUnitCostMinor: d.targetUnitCostMinor,
          quotedUnitCostMinor: d.quotedUnitCostMinor,
        });
        if (!res.errors?.length) {
          itemDraft = null;
          await refetch();
        }
      } else {
        const res = await CreateItem.mutate({
          rfqId: rfq.id,
          sectionId: d.sectionId || null,
          variantId: d.variantId || null,
          description: d.description.trim() || null,
          qtyRequested: d.qtyRequested,
          targetUnitCostMinor: d.targetUnitCostMinor,
          quotedUnitCostMinor: d.quotedUnitCostMinor,
        });
        if (!res.errors?.length) {
          itemDraft = null;
          await refetch();
        }
      }
    } finally {
      busy = false;
    }
  }

  async function deleteItem(id: string) {
    if (!confirm("Delete line item?")) return;
    busy = true;
    try {
      const res = await DeleteItem.mutate({ id });
      if (!res.errors?.length) await refetch();
    } finally {
      busy = false;
    }
  }

  // ---- Cell Inline Editing ----
  type CellField = "qty" | "targetCost" | "quotedCost";
  let cellEdit = $state<{ id: string; field: CellField } | null>(null);
  let cellNum = $state<number>(0);

  function startCellEdit(
    i: NonNullable<typeof rfq>["items"][number],
    field: CellField
  ) {
    if (!isEditable) return;
    cellEdit = { id: i.id, field };
    cellNum =
      field === "qty"
        ? i.qtyRequested
        : field === "targetCost"
        ? i.targetUnitCostMinor
        : i.quotedUnitCostMinor;
  }

  async function commitCell() {
    const edit = cellEdit;
    if (!edit || !rfq) return;
    cellEdit = null;

    const patch: any = { id: edit.id };
    if (edit.field === "qty") patch.qtyRequested = cellNum;
    if (edit.field === "targetCost") patch.targetUnitCostMinor = cellNum;
    if (edit.field === "quotedCost") patch.quotedUnitCostMinor = cellNum;

    await UpdateItem.mutate(patch);
    await refetch();
  }

  // ---- Calculations ----
  const items = $derived(rfq?.items ?? []);

  const totalTargetCost = $derived(
    items.reduce((sum, i) => sum + i.qtyRequested * i.targetUnitCostMinor, 0)
  );
  const totalQuotedCost = $derived(
    items.reduce((sum, i) => sum + i.qtyRequested * (i.quotedUnitCostMinor || i.targetUnitCostMinor), 0)
  );

  const statusClass = (s: string) =>
    s === "draft"
      ? "bg-muted text-muted-foreground"
      : s === "sent"
      ? "bg-sky-100 text-sky-700"
      : s === "received"
      ? "bg-purple-100 text-purple-700"
      : s === "awarded"
      ? "bg-emerald-100 text-emerald-700"
      : "bg-red-100 text-red-700";

  // Split line text into Product Name and SKU for visual clarity
  const lineParts = (i: (typeof items)[number]): { name: string; sku: string | null } => {
    if (!i.variantId) return { name: i.description ?? "—", sku: null };
    const full = variantLabel(i.variantId);
    if (!full) return { name: "Unknown", sku: null };
    const idx = full.indexOf(" · ");
    if (idx === -1) return { name: full, sku: null };
    return { name: full.slice(0, idx), sku: full.slice(idx + 3) };
  };
</script>

<svelte:head>
  <title>{rfq ? `${rfq.rfqNumber} · RFQ` : "RFQ Detail"} · Retale Console</title>
</svelte:head>

{#if $RfqDetail.fetching && !rfq}
  <div class="p-8 text-center text-sm text-muted-foreground">Loading RFQ…</div>
{:else if $RfqDetail.errors?.length || !rfq}
  <div class="p-8 text-center text-sm text-destructive">
    {$RfqDetail.errors?.[0]?.message ?? "RFQ not found"}
  </div>
{:else}
  <div class="space-y-6">
    <!-- Header bar -->
    <div class="flex items-start justify-between">
      <div>
        <div class="flex items-center gap-3">
          <h1 class="text-2xl font-bold font-mono">{rfq.rfqNumber}</h1>
          <Badge class={statusClass(rfq.status)}>{rfq.status}</Badge>
        </div>
        <p class="text-sm text-muted-foreground mt-1">
          Created {new Date(rfq.createdAt).toLocaleDateString()}
        </p>
      </div>

      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" onclick={() => window.print()}>
          <Printer class="mr-1.5 size-4" /> Print / Export
        </Button>

        {#if isEditable}
          {#if rfq.status === "draft"}
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onclick={() => setStatus("sent")}
            >
              Mark Sent
            </Button>
          {:else if rfq.status === "sent"}
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onclick={() => setStatus("received")}
            >
              Mark Quote Received
            </Button>
          {/if}

          <Button
            size="sm"
            class="bg-emerald-600 hover:bg-emerald-700 text-white"
            disabled={busy || items.length === 0}
            onclick={convertToPO}
          >
            <ArrowRight class="mr-1.5 size-4" /> Award &amp; Convert to PO
          </Button>

          <Button
            variant="ghost"
            size="sm"
            class="text-destructive hover:text-destructive"
            disabled={busy}
            onclick={deleteRfq}
          >
            <Trash2 class="size-4" />
          </Button>
        {/if}
      </div>
    </div>

    {#if feedback}
      <div
        class="rounded-md p-3 text-sm {feedback.ok
          ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
          : 'bg-destructive/10 text-destructive border border-destructive/20'}"
      >
        {feedback.text}
      </div>
    {/if}

    <!-- Header form card -->
    <div class="rounded-lg border bg-card p-5 space-y-4">
      <div class="grid grid-cols-4 gap-4">
        <label class="space-y-1">
          <span class="text-xs font-semibold uppercase text-muted-foreground"
            >Vendor</span
          >
          {#if isEditable}
            <Combobox
              options={vendorOptions}
              bind:value={form.vendorId}
              placeholder="Select vendor…"
            />
          {:else}
            <p class="text-sm font-medium">{rfq.snapshotVendorName}</p>
          {/if}
        </label>

        <label class="space-y-1">
          <span class="text-xs font-semibold uppercase text-muted-foreground"
            >RFQ Date</span
          >
          {#if isEditable}
            <Input type="date" bind:value={form.date} />
          {:else}
            <p class="text-sm font-medium">{rfq.date}</p>
          {/if}
        </label>

        <label class="space-y-1">
          <span class="text-xs font-semibold uppercase text-muted-foreground"
            >Due Date</span
          >
          {#if isEditable}
            <Input type="date" bind:value={form.dueDate} />
          {:else}
            <p class="text-sm font-medium">{rfq.dueDate ?? "—"}</p>
          {/if}
        </label>

        <label class="space-y-1">
          <span class="text-xs font-semibold uppercase text-muted-foreground"
            >Status</span
          >
          {#if isEditable}
            <Select bind:value={form.status}>
              <option value="draft">Draft</option>
              <option value="sent">Sent to Vendor</option>
              <option value="received">Quote Received</option>
              <option value="awarded">Awarded</option>
              <option value="cancelled">Cancelled</option>
            </Select>
          {:else}
            <p class="text-sm font-medium capitalize">{rfq.status}</p>
          {/if}
        </label>
      </div>

      <div class="grid grid-cols-2 gap-4">
        <label class="space-y-1">
          <span class="text-xs font-semibold uppercase text-muted-foreground"
            >Internal Memo</span
          >
          {#if isEditable}
            <Textarea bind:value={form.memo} rows={2} />
          {:else}
            <p class="text-sm text-muted-foreground">{rfq.memo ?? "—"}</p>
          {/if}
        </label>

        <label class="space-y-1">
          <span class="text-xs font-semibold uppercase text-muted-foreground"
            >Terms &amp; Conditions</span
          >
          {#if isEditable}
            <Textarea bind:value={form.termsAndConditions} rows={2} />
          {:else}
            <p class="text-sm text-muted-foreground">
              {rfq.termsAndConditions ?? "—"}
            </p>
          {/if}
        </label>
      </div>

      {#if isEditable}
        <div class="flex justify-end pt-2 border-t">
          <Button size="sm" disabled={busy} onclick={saveHeader}
            >Save Header Changes</Button
          >
        </div>
      {/if}
    </div>

    <!-- Summary metrics -->
    <div class="grid grid-cols-2 gap-4">
      <div class="rounded-lg border bg-card p-4">
        <p class="text-xs font-medium text-muted-foreground">Target Total Cost</p>
        <p class="text-xl font-bold font-mono text-foreground mt-1">
          {formatMoney(totalTargetCost)}
        </p>
      </div>
      <div class="rounded-lg border bg-card p-4">
        <p class="text-xs font-medium text-muted-foreground">Quoted Total Cost</p>
        <p class="text-xl font-bold font-mono text-emerald-600 mt-1">
          {formatMoney(totalQuotedCost)}
        </p>
      </div>
    </div>

    <!-- Items & Sections Table -->
    <div class="space-y-4">
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-semibold">Line Items ({items.length})</h2>
        {#if isEditable}
          <div class="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onclick={() => (newSectionName = "")}
            >
              Add Section
            </Button>
            <Button size="sm" onclick={() => startAddItem("")}>
              Add Line Item
            </Button>
          </div>
        {/if}
      </div>

      {#if newSectionName !== null}
        <div class="flex items-center gap-2 border p-3 rounded-lg bg-card">
          <Input
            placeholder="Section name…"
            bind:value={newSectionName}
            class="max-w-xs"
          />
          <Button size="sm" onclick={addSection} disabled={busy}>Add</Button>
          <Button
            size="sm"
            variant="ghost"
            onclick={() => (newSectionName = null)}>Cancel</Button
          >
        </div>
      {/if}

      {#if itemDraft}
        <div class="border rounded-lg p-4 bg-card space-y-3">
          <h3 class="text-sm font-semibold">
            {itemDraft.id ? "Edit Line Item" : "Add Line Item"}
          </h3>
          <div class="grid grid-cols-4 gap-3">
            <label class="space-y-1 col-span-2">
              <span class="text-xs font-medium">Product / Variant</span>
              <Combobox
                options={variantOptions}
                bind:value={itemDraft.variantId}
                placeholder="Search variant…"
              />
            </label>
            <label class="space-y-1 col-span-2">
              <span class="text-xs font-medium"
                >Description (Non-stock fallback)</span
              >
              <Input
                bind:value={itemDraft.description}
                placeholder="Custom line description…"
              />
            </label>
          </div>
          <div class="grid grid-cols-3 gap-3">
            <label class="space-y-1">
              <span class="text-xs font-medium">Qty Requested</span>
              <NumericInput bind:value={itemDraft.qtyRequested} min={1} />
            </label>
            <label class="space-y-1">
              <span class="text-xs font-medium">Target Unit Cost (Rp)</span>
              <MoneyInput bind:value={itemDraft.targetUnitCostMinor} />
            </label>
            <label class="space-y-1">
              <span class="text-xs font-medium">Quoted Unit Cost (Rp)</span>
              <MoneyInput bind:value={itemDraft.quotedUnitCostMinor} />
            </label>
          </div>
          <div class="flex justify-end gap-2 pt-2">
            <Button
              size="sm"
              variant="ghost"
              onclick={() => (itemDraft = null)}>Cancel</Button
            >
            <Button size="sm" disabled={busy} onclick={saveItem}>Save Line</Button>
          </div>
        </div>
      {/if}

      <div class="overflow-hidden rounded-lg border bg-card">
        <table class="w-full text-sm">
          <thead class="border-b bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th class="px-4 py-2 font-medium">Product / Description</th>
              <th class="px-4 py-2 text-right font-medium">Qty Requested</th>
              <th class="px-4 py-2 text-right font-medium">Target Cost</th>
              <th class="px-4 py-2 text-right font-medium">Quoted Cost</th>
              <th class="px-4 py-2 text-right font-medium">Target Total</th>
              <th class="px-4 py-2 text-right font-medium">Quoted Total</th>
              {#if isEditable}
                <th class="w-16 px-4 py-2"></th>
              {/if}
            </tr>
          </thead>
          <tbody>
            {#each items as i (i.id)}
              {@const parts = lineParts(i)}
              <tr class="border-b last:border-0 hover:bg-muted/40">
                <td class="px-4 py-2">
                  <span class="font-medium">{parts.name}</span>
                  {#if parts.sku}
                    <span class="ml-1.5 font-mono text-xs text-muted-foreground"
                      >{parts.sku}</span
                    >
                  {/if}
                </td>
                <td class="px-4 py-2 text-right tabular-nums">
                  {#if cellEdit?.id === i.id && cellEdit?.field === "qty"}
                    <NumericInput
                      bind:value={cellNum}
                      onblur={commitCell}
                      class="h-7 w-20 text-right"
                      autofocus
                    />
                  {:else if isEditable}
                    <button
                      type="button"
                      class="rounded px-1.5 py-0.5 hover:bg-accent"
                      onclick={() => startCellEdit(i, "qty")}
                    >
                      {i.qtyRequested}
                    </button>
                  {:else}
                    {i.qtyRequested}
                  {/if}
                </td>

                <td class="px-4 py-2 text-right tabular-nums">
                  {#if cellEdit?.id === i.id && cellEdit?.field === "targetCost"}
                    <MoneyInput
                      bind:value={cellNum}
                      onblur={commitCell}
                      autofocus
                    />
                  {:else if isEditable}
                    <button
                      type="button"
                      class="rounded px-1.5 py-0.5 hover:bg-accent"
                      onclick={() => startCellEdit(i, "targetCost")}
                    >
                      {formatMoney(i.targetUnitCostMinor)}
                    </button>
                  {:else}
                    {formatMoney(i.targetUnitCostMinor)}
                  {/if}
                </td>

                <td class="px-4 py-2 text-right tabular-nums">
                  {#if cellEdit?.id === i.id && cellEdit?.field === "quotedCost"}
                    <MoneyInput
                      bind:value={cellNum}
                      onblur={commitCell}
                      autofocus
                    />
                  {:else if isEditable}
                    <button
                      type="button"
                      class="rounded px-1.5 py-0.5 hover:bg-accent font-semibold text-emerald-700"
                      onclick={() => startCellEdit(i, "quotedCost")}
                    >
                      {formatMoney(i.quotedUnitCostMinor)}
                    </button>
                  {:else}
                    <span class="font-semibold text-emerald-700">
                      {formatMoney(i.quotedUnitCostMinor)}
                    </span>
                  {/if}
                </td>

                <td class="px-4 py-2 text-right tabular-nums font-mono">
                  {formatMoney(i.qtyRequested * i.targetUnitCostMinor)}
                </td>

                <td class="px-4 py-2 text-right tabular-nums font-mono font-semibold text-emerald-700">
                  {formatMoney(i.qtyRequested * (i.quotedUnitCostMinor || i.targetUnitCostMinor))}
                </td>

                {#if isEditable}
                  <td class="px-4 py-2 text-right">
                    <div class="flex items-center justify-end gap-1">
                      <IconButton
                        icon={Pencil}
                        label="Edit line"
                        onclick={() => startEditItem(i)}
                      />
                      <IconButton
                        icon={Trash2}
                        label="Delete line"
                        variant="destructive"
                        onclick={() => deleteItem(i.id)}
                      />
                    </div>
                  </td>
                {/if}
              </tr>
            {:else}
              <tr>
                <td
                  colspan={isEditable ? 7 : 6}
                  class="px-4 py-10 text-center text-muted-foreground"
                >
                  No items in this RFQ.
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  </div>
{/if}
