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
    query PurchaseDetail($id: ID!) {
      purchase(id: $id) {
        id
        vendorId
        snapshotVendorName
        date
        sourceDocument
        memo
        sendDueDate
        status
        revision
        lastSentAt
        totalInvoiceCost
        hasUnsentChanges
        sections {
          id
          name
          sortOrder
        }
        items {
          id
          sectionId
          variantId
          description
          qtyOrdered
          qtyDelivered
          unitCostMinor
          sortOrder
        }
        sends {
          id
          channel
          recipient
          revision
          status
          sentAt
          expectedDeliveryDate
          note
          createdAt
        }
        unmappedLines {
          id
        }
      }
      vendors {
        id
        name
      }
      products(includeArchived: true) {
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

  const UpdatePurchase = graphql(`
    mutation ConsoleUpdatePurchase(
      $id: ID!
      $vendorId: ID
      $snapshotVendorName: String
      $date: String
      $sourceDocument: String
      $memo: String
      $sendDueDate: String
    ) {
      updatePurchase(
        id: $id
        vendorId: $vendorId
        snapshotVendorName: $snapshotVendorName
        date: $date
        sourceDocument: $sourceDocument
        memo: $memo
        sendDueDate: $sendDueDate
      ) {
        id
      }
    }
  `);

  const CancelPurchase = graphql(`
    mutation ConsoleCancelPurchase($id: ID!) {
      cancelPurchase(id: $id) {
        id
        status
      }
    }
  `);

  const ClonePurchase = graphql(`
    mutation ConsoleClonePurchase($id: ID!) {
      clonePurchase(id: $id) {
        id
      }
    }
  `);

  const CreateSection = graphql(`
    mutation ConsoleCreatePurchaseSection($purchaseId: ID!, $name: String!) {
      createPurchaseSection(purchaseId: $purchaseId, name: $name) {
        id
      }
    }
  `);

  const DeleteSection = graphql(`
    mutation ConsoleDeletePurchaseSection($id: ID!) {
      deletePurchaseSection(id: $id)
    }
  `);

  const CreateItem = graphql(`
    mutation ConsoleCreatePurchaseItem(
      $purchaseId: ID!
      $sectionId: ID
      $variantId: ID
      $description: String
      $qtyOrdered: Float!
      $unitCostMinor: Float!
    ) {
      createPurchaseItem(
        purchaseId: $purchaseId
        sectionId: $sectionId
        variantId: $variantId
        description: $description
        qtyOrdered: $qtyOrdered
        unitCostMinor: $unitCostMinor
      ) {
        id
      }
    }
  `);

  const UpdateItem = graphql(`
    mutation ConsoleUpdatePurchaseItem(
      $id: ID!
      $sectionId: ID
      $variantId: ID
      $description: String
      $qtyOrdered: Float
      $unitCostMinor: Float
    ) {
      updatePurchaseItem(
        id: $id
        sectionId: $sectionId
        variantId: $variantId
        description: $description
        qtyOrdered: $qtyOrdered
        unitCostMinor: $unitCostMinor
      ) {
        id
      }
    }
  `);

  const DeleteItem = graphql(`
    mutation ConsoleDeletePurchaseItem($id: ID!) {
      deletePurchaseItem(id: $id)
    }
  `);

  const RecordSend = graphql(`
    mutation ConsoleRecordPurchaseSend(
      $purchaseId: ID!
      $channel: PurchaseSendChannel!
      $recipient: String!
      $note: String
    ) {
      recordPurchaseSend(
        purchaseId: $purchaseId
        channel: $channel
        recipient: $recipient
        note: $note
      ) {
        id
      }
    }
  `);

  const ConfirmSend = graphql(`
    mutation ConsoleConfirmPurchaseSend($id: ID!, $expectedDeliveryDate: String) {
      confirmPurchaseSend(id: $id, expectedDeliveryDate: $expectedDeliveryDate) {
        id
        status
      }
    }
  `);

  // Fetched imperatively when the composer opens / its channel changes — the
  // API renders the message body and resolves the wa.me / mailto: deep link.
  const SendDraftQuery = graphql(`
    query ConsolePurchaseSendDraft(
      $purchaseId: ID!
      $channel: PurchaseSendChannel!
      $recipientOverride: String
    ) {
      purchaseSendDraft(
        purchaseId: $purchaseId
        channel: $channel
        recipientOverride: $recipientOverride
      ) {
        channel
        recipient
        recipientAvailable
        subject
        body
        deepLink
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const PurchaseDetail = $derived(data.PurchaseDetail);

  const purchase = $derived($PurchaseDetail.data?.purchase);
  const vendors = $derived($PurchaseDetail.data?.vendors ?? []);
  const products = $derived($PurchaseDetail.data?.products ?? []);

  // Flat variant options for the item editor — "Product · SKU (label)".
  interface VariantOption {
    id: string;
    label: string;
  }
  const variantOptions = $derived.by<VariantOption[]>(() => {
    const out: VariantOption[] = [];
    for (const p of products) {
      for (const v of p.variants) {
        const suffix = v.label ? `${v.sku} · ${v.label}` : v.sku;
        out.push({ id: v.id, label: `${p.name} · ${suffix}` });
      }
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  });
  const variantLabel = (id: string | null | undefined) =>
    id ? (variantOptions.find((v) => v.id === id)?.label ?? "Unknown") : null;

  // ---- Viewer permissions --------------------------------------------------
  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canEdit = $derived(has("purchase.edit"));
  const canCancel = $derived(has("purchase.cancel"));
  const canCreate = $derived(has("purchase.create"));
  const canSend = $derived(has("purchase.send"));

  // A cancelled purchase is a frozen document — editing is closed.
  const editable = $derived(canEdit && purchase?.status !== "cancelled");

  // ---- Header form ---------------------------------------------------------
  interface HeaderForm {
    vendorId: string;
    snapshotVendorName: string;
    date: string;
    sourceDocument: string;
    memo: string;
    sendDueDate: string;
  }
  let form = $state<HeaderForm>({
    vendorId: "",
    snapshotVendorName: "",
    date: "",
    sourceDocument: "",
    memo: "",
    sendDueDate: "",
  });

  const dateInput = (iso: string | null | undefined) =>
    iso ? new Date(iso).toISOString().slice(0, 10) : "";

  // Reset the form when a different purchase loads — not on a plain refetch,
  // so in-progress edits survive.
  let syncedId = $state("");
  $effect(() => {
    const p = purchase;
    if (p && p.id !== syncedId) {
      syncedId = p.id;
      form = {
        vendorId: p.vendorId ?? "",
        snapshotVendorName: p.snapshotVendorName,
        date: dateInput(p.date),
        sourceDocument: p.sourceDocument ?? "",
        memo: p.memo ?? "",
        sendDueDate: dateInput(p.sendDueDate),
      };
    }
  });

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

  const refetch = () =>
    purchase && PurchaseDetail.fetch({ variables: { id: purchase.id } });

  async function saveHeader() {
    if (!purchase) return;
    await run("Purchase", () =>
      UpdatePurchase.mutate({
        id: purchase.id,
        vendorId: form.vendorId || null,
        // Ad-hoc name only matters with no vendor on file; the API derives
        // the snapshot from the vendor otherwise.
        snapshotVendorName: form.vendorId
          ? undefined
          : form.snapshotVendorName.trim() || undefined,
        date: form.date,
        sourceDocument: form.sourceDocument.trim() || null,
        memo: form.memo.trim() || null,
        sendDueDate: form.sendDueDate || null,
      }),
    );
  }

  async function cancelPurchase() {
    if (!purchase || !confirm("Cancel this purchase? This cannot be undone."))
      return;
    const ok = await run("Purchase", () =>
      CancelPurchase.mutate({ id: purchase.id }),
    );
    if (ok) await refetch();
  }

  async function clonePurchase() {
    if (!purchase) return;
    busy = true;
    feedback = null;
    try {
      const res = await ClonePurchase.mutate({ id: purchase.id });
      if (res.errors?.length) {
        feedback = { ok: false, text: res.errors[0].message };
        return;
      }
      const id = res.data?.clonePurchase.id;
      if (id) await goto(`/purchases/${id}`);
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
    } finally {
      busy = false;
    }
  }

  // ---- Sections ------------------------------------------------------------
  let newSectionName = $state("");

  async function addSection() {
    if (!purchase || !newSectionName.trim()) return;
    const ok = await run("Section", () =>
      CreateSection.mutate({
        purchaseId: purchase.id,
        name: newSectionName.trim(),
      }),
    );
    if (ok) {
      newSectionName = "";
      await refetch();
    }
  }

  async function deleteSection(id: string) {
    if (!confirm("Delete this section? Its items move to no section.")) return;
    const ok = await run("Section", () => DeleteSection.mutate({ id }));
    if (ok) await refetch();
  }

  const sections = $derived(purchase?.sections ?? []);
  const sectionName = (id: string | null | undefined) =>
    id ? (sections.find((s) => s.id === id)?.name ?? "—") : "—";

  // ---- Items ---------------------------------------------------------------
  interface ItemDraft {
    id: string | null; // null → a new item
    sectionId: string;
    variantId: string;
    description: string;
    qtyOrdered: number;
    unitCostMinor: number;
  }
  let itemDraft = $state<ItemDraft | null>(null);

  function newItem() {
    itemDraft = {
      id: null,
      sectionId: "",
      variantId: "",
      description: "",
      qtyOrdered: 1,
      unitCostMinor: 0,
    };
  }

  function editItem(i: NonNullable<typeof purchase>["items"][number]) {
    itemDraft = {
      id: i.id,
      sectionId: i.sectionId ?? "",
      variantId: i.variantId ?? "",
      description: i.description ?? "",
      qtyOrdered: i.qtyOrdered,
      unitCostMinor: i.unitCostMinor,
    };
  }

  async function saveItem() {
    const d = itemDraft;
    if (!d || !purchase) return;
    // A line is either a stock variant or a free-text non-stock line.
    if (!d.variantId && !d.description.trim()) {
      feedback = { ok: false, text: "Pick a variant or enter a description." };
      return;
    }
    const ok = await run("Item", () =>
      d.id
        ? UpdateItem.mutate({
            id: d.id,
            sectionId: d.sectionId || null,
            variantId: d.variantId || null,
            description: d.description.trim() || null,
            qtyOrdered: d.qtyOrdered,
            unitCostMinor: d.unitCostMinor,
          })
        : CreateItem.mutate({
            purchaseId: purchase.id,
            sectionId: d.sectionId || null,
            variantId: d.variantId || null,
            description: d.description.trim() || null,
            qtyOrdered: d.qtyOrdered,
            unitCostMinor: d.unitCostMinor,
          }),
    );
    if (ok) {
      itemDraft = null;
      await refetch();
    }
  }

  async function deleteItem(id: string) {
    if (!confirm("Delete this line?")) return;
    const ok = await run("Item", () => DeleteItem.mutate({ id }));
    if (ok) await refetch();
  }

  const items = $derived(purchase?.items ?? []);
  const lineLabel = (i: (typeof items)[number]) =>
    variantLabel(i.variantId) ?? i.description ?? "—";

  // ---- Sends — deep-link composer -----------------------------------------
  const CHANNELS = ["whatsapp", "email", "manual"];
  interface Composer {
    channel: string;
    recipientOverride: string;
    note: string;
  }
  let composer = $state<Composer | null>(null);
  let previewing = $state(false);

  // The rendered draft (body + resolved recipient + deep link) for the
  // current composer channel / recipient.
  const draft = $derived($SendDraftQuery.data?.purchaseSendDraft);
  // The PDF goes through the console's own cookie-authenticated proxy route.
  const pdfHref = $derived(purchase ? `/purchases/${purchase.id}/po.pdf` : "#");

  async function preview() {
    const c = composer;
    if (!c || !purchase) return;
    previewing = true;
    feedback = null;
    try {
      await SendDraftQuery.fetch({
        variables: {
          purchaseId: purchase.id,
          channel: c.channel as never,
          recipientOverride: c.recipientOverride.trim() || null,
        },
      });
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
    } finally {
      previewing = false;
    }
  }

  function startCompose() {
    composer = { channel: "whatsapp", recipientOverride: "", note: "" };
    preview();
  }

  // The recipient to log: an explicit override wins, else the resolved one.
  const logRecipient = $derived(
    composer?.recipientOverride.trim() || draft?.recipient || "",
  );

  /** Log the send to the purchase's append-only send history. */
  async function logSend() {
    const c = composer;
    if (!c || !purchase || !logRecipient) return;
    const ok = await run("Send", () =>
      RecordSend.mutate({
        purchaseId: purchase.id,
        channel: c.channel as never,
        recipient: logRecipient,
        note: c.note.trim() || null,
      }),
    );
    if (ok) {
      composer = null;
      await refetch();
    }
  }

  async function confirmSend(id: string) {
    const date = prompt("Expected delivery date (YYYY-MM-DD, optional):", "");
    if (date === null) return; // cancelled
    const ok = await run("Send", () =>
      ConfirmSend.mutate({ id, expectedDeliveryDate: date.trim() || null }),
    );
    if (ok) await refetch();
  }

  const sends = $derived(purchase?.sends ?? []);
  const fmtDate = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleDateString("id-ID") : "—";

  const statusClass = (s: string) =>
    s === "open"
      ? "bg-sky-100 text-sky-700"
      : s === "complete"
        ? "bg-emerald-100 text-emerald-700"
        : "bg-muted text-muted-foreground";
</script>

<svelte:head>
  <title>
    {purchase ? purchase.snapshotVendorName : "Purchase"} · Retale Console
  </title>
</svelte:head>

<div class="mx-auto max-w-3xl space-y-6">
  <a
    href="/purchases"
    class="text-sm text-muted-foreground hover:text-foreground"
    >← Back to purchases</a
  >

  {#if $PurchaseDetail.fetching && !purchase}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if !purchase}
    <p class="text-sm text-destructive">Purchase not found.</p>
  {:else}
    <div class="flex items-start justify-between gap-4">
      <div>
        <h1 class="text-xl font-semibold">{purchase.snapshotVendorName}</h1>
        <p class="text-sm text-muted-foreground">
          {fmtDate(purchase.date)} · revision {purchase.revision} ·
          {formatMoney(purchase.totalInvoiceCost)}
        </p>
      </div>
      <div class="flex items-center gap-3">
        <Badge class={statusClass(purchase.status)}>{purchase.status}</Badge>
        {#if canCreate}
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onclick={clonePurchase}>Clone</Button
          >
        {/if}
        {#if canCancel && purchase.status !== "cancelled"}
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onclick={cancelPurchase}>Cancel</Button
          >
        {/if}
      </div>
    </div>

    {#if feedback}
      <p class="text-sm {feedback.ok ? 'text-emerald-700' : 'text-destructive'}">
        {feedback.text}
      </p>
    {/if}

    {#if purchase.status === "cancelled"}
      <p
        class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
      >
        This purchase is cancelled — it is read-only.
      </p>
    {:else if !canEdit}
      <p
        class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
      >
        You have read-only access to purchases — editing is disabled.
      </p>
    {/if}

    {#if purchase.hasUnsentChanges && purchase.lastSentAt}
      <p
        class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
      >
        This purchase has edits not covered by the latest confirmed send.
      </p>
    {/if}

    <!-- Header -->
    <section class="space-y-4 rounded-lg border bg-card p-5">
      <h2 class="text-sm font-semibold">Details</h2>
      <div class="grid grid-cols-2 gap-4">
        <label class="space-y-1">
          <span class="text-sm font-medium">Vendor</span>
          <Select bind:value={form.vendorId} disabled={!editable}>
            <option value="">— Ad-hoc vendor —</option>
            {#each vendors as v (v.id)}
              <option value={v.id}>{v.name}</option>
            {/each}
          </Select>
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Ad-hoc vendor name</span>
          <Input
            bind:value={form.snapshotVendorName}
            disabled={!editable || form.vendorId !== ""}
          />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Date</span>
          <Input type="date" bind:value={form.date} disabled={!editable} />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Send-by date</span>
          <Input
            type="date"
            bind:value={form.sendDueDate}
            disabled={!editable}
          />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Source document</span>
          <Input
            bind:value={form.sourceDocument}
            placeholder="Vendor quote / invoice ref"
            disabled={!editable}
          />
        </label>
      </div>
      <label class="space-y-1">
        <span class="text-sm font-medium">Memo</span>
        <Textarea
          bind:value={form.memo}
          disabled={!editable}
          class="h-20 resize-none"
        />
      </label>
      <div class="flex justify-end">
        <Button disabled={busy || !editable} onclick={saveHeader}>
          Save details
        </Button>
      </div>
    </section>

    <!-- Sections -->
    <section class="space-y-3 rounded-lg border bg-card p-5">
      <h2 class="text-sm font-semibold">Sections ({sections.length})</h2>
      {#if sections.length}
        <ul class="space-y-1 text-sm">
          {#each sections as s (s.id)}
            <li class="flex items-center justify-between">
              <span>{s.name}</span>
              <button
                class="text-xs text-destructive hover:underline disabled:cursor-not-allowed disabled:opacity-40"
                disabled={busy || !editable}
                onclick={() => deleteSection(s.id)}>Delete</button
              >
            </li>
          {/each}
        </ul>
      {:else}
        <p class="text-sm text-muted-foreground">
          No sections — items can sit ungrouped.
        </p>
      {/if}
      {#if editable}
        <div class="flex gap-2">
          <Input
            bind:value={newSectionName}
            placeholder="New section name"
          />
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !newSectionName.trim()}
            onclick={addSection}>Add</Button
          >
        </div>
      {/if}
    </section>

    <!-- Items -->
    <section class="space-y-3 rounded-lg border bg-card p-5">
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold">Lines ({items.length})</h2>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !editable}
          onclick={newItem}>Add line</Button
        >
      </div>

      <table class="w-full text-sm">
        <thead class="border-b text-left text-muted-foreground">
          <tr>
            <th class="py-1.5 font-medium">Line</th>
            <th class="py-1.5 font-medium">Section</th>
            <th class="py-1.5 text-right font-medium">Ordered</th>
            <th class="py-1.5 text-right font-medium">Delivered</th>
            <th class="py-1.5 text-right font-medium">Unit cost</th>
            <th class="py-1.5 text-right font-medium">Line total</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each items as i (i.id)}
            <tr class="border-b last:border-0">
              <td class="py-1.5">{lineLabel(i)}</td>
              <td class="py-1.5 text-muted-foreground">
                {sectionName(i.sectionId)}
              </td>
              <td class="py-1.5 text-right">{i.qtyOrdered}</td>
              <td class="py-1.5 text-right">{i.qtyDelivered}</td>
              <td class="py-1.5 text-right">{formatMoney(i.unitCostMinor)}</td>
              <td class="py-1.5 text-right">
                {formatMoney(i.qtyOrdered * i.unitCostMinor)}
              </td>
              <td class="py-1.5 text-right whitespace-nowrap">
                <button
                  class="text-xs text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={busy || !editable}
                  onclick={() => editItem(i)}>Edit</button
                >
                <button
                  class="ml-2 text-xs text-destructive hover:underline disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={busy || !editable}
                  onclick={() => deleteItem(i.id)}>Delete</button
                >
              </td>
            </tr>
          {/each}
          {#if items.length === 0}
            <tr>
              <td colspan="7" class="py-6 text-center text-muted-foreground">
                No lines yet.
              </td>
            </tr>
          {/if}
        </tbody>
      </table>

      {#if itemDraft}
        <div class="space-y-3 rounded-md border bg-background p-4">
          <h3 class="text-sm font-semibold">
            {itemDraft.id ? "Edit line" : "New line"}
          </h3>
          <div class="grid grid-cols-2 gap-3">
            <label class="space-y-1">
              <span class="text-xs font-medium">Variant (stock line)</span>
              <Select bind:value={itemDraft.variantId} disabled={!editable}>
                <option value="">— Non-stock line —</option>
                {#each variantOptions as v (v.id)}
                  <option value={v.id}>{v.label}</option>
                {/each}
              </Select>
            </label>
            <label class="space-y-1">
              <span class="text-xs font-medium">Section</span>
              <Select bind:value={itemDraft.sectionId} disabled={!editable}>
                <option value="">— No section —</option>
                {#each sections as s (s.id)}
                  <option value={s.id}>{s.name}</option>
                {/each}
              </Select>
            </label>
            <label class="space-y-1 col-span-2">
              <span class="text-xs font-medium">Description</span>
              <Input
                bind:value={itemDraft.description}
                placeholder={itemDraft.variantId
                  ? "Optional note"
                  : "Required for a non-stock line"}
                disabled={!editable}
              />
            </label>
            <label class="space-y-1">
              <span class="text-xs font-medium">Qty ordered</span>
              <Input
                type="number"
                bind:value={itemDraft.qtyOrdered}
                disabled={!editable}
              />
            </label>
            <label class="space-y-1">
              <span class="text-xs font-medium">Unit cost (minor units)</span>
              <Input
                type="number"
                bind:value={itemDraft.unitCostMinor}
                disabled={!editable}
              />
            </label>
          </div>
          <div class="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onclick={() => (itemDraft = null)}>Cancel</Button
            >
            <Button size="sm" disabled={busy || !editable} onclick={saveItem}>
              {itemDraft.id ? "Save line" : "Add line"}
            </Button>
          </div>
        </div>
      {/if}
    </section>

    <!-- Sends -->
    <section class="space-y-3 rounded-lg border bg-card p-5">
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold">Send log ({sends.length})</h2>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !canSend || purchase.status === "cancelled"}
          onclick={startCompose}>Compose send</Button
        >
      </div>

      {#if sends.length}
        <table class="w-full text-sm">
          <thead class="border-b text-left text-muted-foreground">
            <tr>
              <th class="py-1.5 font-medium">Channel</th>
              <th class="py-1.5 font-medium">Recipient</th>
              <th class="py-1.5 text-right font-medium">Rev</th>
              <th class="py-1.5 font-medium">Status</th>
              <th class="py-1.5 font-medium">Expected</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each sends as s (s.id)}
              <tr class="border-b last:border-0">
                <td class="py-1.5">{s.channel}</td>
                <td class="py-1.5">{s.recipient}</td>
                <td class="py-1.5 text-right">{s.revision}</td>
                <td class="py-1.5">
                  <Badge
                    class={s.status === "sent"
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-sky-100 text-sky-700"}
                  >
                    {s.status}
                  </Badge>
                </td>
                <td class="py-1.5">{fmtDate(s.expectedDeliveryDate)}</td>
                <td class="py-1.5 text-right">
                  {#if s.status === "prepared" && canSend}
                    <button
                      class="text-xs text-primary hover:underline disabled:opacity-40"
                      disabled={busy}
                      onclick={() => confirmSend(s.id)}>Confirm sent</button
                    >
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <p class="text-sm text-muted-foreground">Not sent to the vendor yet.</p>
      {/if}

      {#if composer}
        <div class="space-y-3 rounded-md border bg-background p-4">
          <h3 class="text-sm font-semibold">Compose send</h3>
          <div class="grid grid-cols-2 gap-3">
            <label class="space-y-1">
              <span class="text-xs font-medium">Channel</span>
              <Select bind:value={composer.channel} onchange={preview}>
                {#each CHANNELS as c (c)}<option value={c}>{c}</option>{/each}
              </Select>
            </label>
            <label class="space-y-1">
              <span class="text-xs font-medium">
                Recipient override
                <span class="text-muted-foreground">(optional)</span>
              </span>
              <Input
                bind:value={composer.recipientOverride}
                placeholder={composer.channel === "email"
                  ? "Vendor email"
                  : "Vendor phone"}
                onblur={preview}
              />
            </label>
          </div>

          {#if previewing}
            <p class="text-sm text-muted-foreground">Rendering preview…</p>
          {:else if draft}
            <div class="space-y-2">
              {#if composer.channel !== "manual"}
                <p class="text-xs">
                  <span class="font-medium">Recipient:</span>
                  {draft.recipient ?? "—"}
                  {#if !draft.recipientAvailable}
                    <Badge class="ml-1 bg-amber-100 text-amber-800">
                      {draft.recipient
                        ? "unusable for this channel"
                        : "none on file — add an override"}
                    </Badge>
                  {/if}
                </p>
              {/if}
              {#if composer.channel === "email"}
                <p class="text-xs">
                  <span class="font-medium">Subject:</span>
                  {draft.subject}
                </p>
              {/if}
              <Textarea
                value={draft.body}
                readonly
                class="h-56 resize-none font-mono text-xs"
              />
            </div>

            <div class="flex flex-wrap items-center gap-2">
              {#if composer.channel === "manual"}
                <span class="text-xs text-muted-foreground">
                  Manual send — copy the message above and send it off-system.
                </span>
              {:else if draft.deepLink}
                <a
                  href={draft.deepLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  Open in {composer.channel === "whatsapp"
                    ? "WhatsApp"
                    : "email"}
                </a>
              {:else}
                <span class="text-xs text-muted-foreground">
                  Add a usable recipient to enable the
                  {composer.channel} link.
                </span>
              {/if}
              <a
                href={pdfHref}
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent"
              >
                Download PDF
              </a>
            </div>
          {/if}

          <label class="space-y-1">
            <span class="text-xs font-medium">Send note (optional)</span>
            <Input bind:value={composer.note} placeholder="Logged with the send" />
          </label>
          <p class="text-xs text-muted-foreground">
            Opening the link doesn't log anything. Record the send once it's
            actually away — whatsapp / email log as <em>prepared</em> (confirm
            later); manual logs as sent at once.
          </p>
          <div class="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onclick={() => (composer = null)}>Cancel</Button
            >
            <Button
              size="sm"
              disabled={busy || previewing || !logRecipient}
              onclick={logSend}>Record this send</Button
            >
          </div>
        </div>
      {/if}
    </section>
  {/if}
</div>
