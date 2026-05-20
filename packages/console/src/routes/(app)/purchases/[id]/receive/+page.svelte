<script lang="ts">
  import { CachePolicy, graphql } from "$houdini";
  import { page } from "$app/state";
  import type { Viewer } from "../../../+layout.server";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import Select from "$lib/components/ui/select.svelte";
  import type { PageData } from "./$types";

  // Bundled query: purchase header (for context + line metadata),
  // openReceivingCheck (draft existence), receivingCheckLines (the working
  // grid), and locations (for the target picker when starting a new check).
  graphql(`
    query ReceivingCheck($purchaseId: ID!) {
      purchase(id: $purchaseId) {
        id
        snapshotVendorName
        date
        status
        items {
          id
          variantId
          description
          unitCostMinor
        }
      }
      openReceivingCheck(purchaseId: $purchaseId) {
        id
        date
        targetLocationId
        targetLocation { id name }
        status
      }
      receivingCheckLines(purchaseId: $purchaseId) {
        purchaseItem {
          id
          variantId
          description
        }
        qtyOrdered
        qtyDelivered
        remaining
        qtyInCheck
        status
        provisionalStatus
      }
      locations(includeArchived: false) {
        id
        name
      }
      products(includeArchived: true) {
        id
        name
        variants { id sku label }
      }
    }
  `);

  const StartReceivingCheck = graphql(`
    mutation ConsoleStartReceivingCheck(
      $purchaseId: ID!
      $targetLocationId: ID!
    ) {
      startReceivingCheck(
        purchaseId: $purchaseId
        targetLocationId: $targetLocationId
      ) {
        id
      }
    }
  `);

  const SetReceivingCheckLine = graphql(`
    mutation ConsoleSetReceivingCheckLine(
      $deliveryId: ID!
      $purchaseItemId: ID!
      $qty: Float!
    ) {
      setReceivingCheckLine(
        deliveryId: $deliveryId
        purchaseItemId: $purchaseItemId
        qty: $qty
      ) {
        id
      }
    }
  `);

  const CommitReceivingCheck = graphql(`
    mutation ConsoleCommitReceivingCheck($deliveryId: ID!) {
      commitReceivingCheck(deliveryId: $deliveryId) { id status }
    }
  `);

  const ResolveScan = graphql(`
    query ConsoleResolveReceivingScan($purchaseId: ID!, $code: String!) {
      resolveReceivingScan(purchaseId: $purchaseId, code: $code) {
        id
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const ReceivingCheck = $derived(data.ReceivingCheck);
  const purchase = $derived($ReceivingCheck.data?.purchase);
  const draft = $derived($ReceivingCheck.data?.openReceivingCheck);
  const lines = $derived($ReceivingCheck.data?.receivingCheckLines ?? []);
  const locations = $derived($ReceivingCheck.data?.locations ?? []);
  const products = $derived($ReceivingCheck.data?.products ?? []);

  // Flat variant lookup so the lines grid can label by SKU / product name.
  const variantLabel = $derived.by(() => {
    const m = new Map<string, string>();
    for (const p of products) {
      for (const v of p.variants) {
        const suffix = v.label ? `${v.sku} · ${v.label}` : v.sku;
        m.set(v.id, `${p.name} · ${suffix}`);
      }
    }
    return (id: string | null | undefined, fallback: string | null | undefined) =>
      id ? (m.get(id) ?? fallback ?? "Unknown") : (fallback ?? "—");
  });

  // ---- Viewer permissions --------------------------------------------------
  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canDraft = $derived(has("delivery.draft"));
  const canCommit = $derived(has("delivery.commit"));

  // ---- Start form ---------------------------------------------------------
  let startLocationId = $state("");
  $effect(() => {
    if (!startLocationId && locations.length > 0) {
      startLocationId = locations[0].id;
    }
  });

  // ---- Per-line qty drafts ------------------------------------------------
  // Local edits to qty so the user can tab through fields without each
  // keystroke firing a mutation; the upsert fires on blur / Enter.
  // Seed a draft from the server's `qtyInCheck` only the first time a line
  // appears. Past that, the draft is owned by the input — refetches must not
  // clobber edits the user is still composing, which is what caused the field
  // to snap back to 0 on blur.
  const qtyDrafts = $state<Record<string, number>>({});
  $effect(() => {
    for (const l of lines) {
      if (!(l.purchaseItem.id in qtyDrafts)) {
        qtyDrafts[l.purchaseItem.id] = l.qtyInCheck;
      }
    }
  });

  let busy = $state(false);
  let feedback = $state<{ ok: boolean; text: string } | null>(null);
  let scanCode = $state("");
  let lastScanHit = $state<string | null>(null);

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
    purchase &&
    ReceivingCheck.fetch({
      variables: { purchaseId: purchase.id },
      policy: CachePolicy.NetworkOnly,
    });

  async function startCheck() {
    if (!purchase || !startLocationId) return;
    const ok = await run("Receiving check", () =>
      StartReceivingCheck.mutate({
        purchaseId: purchase.id,
        targetLocationId: startLocationId,
      }),
    );
    if (ok) await refetch();
  }

  async function saveLine(purchaseItemId: string) {
    if (!draft) return;
    const qty = qtyDrafts[purchaseItemId];
    if (qty == null || Number.isNaN(qty) || qty < 0) {
      feedback = { ok: false, text: "Quantity must be ≥ 0." };
      return;
    }
    const ok = await run("Line", () =>
      SetReceivingCheckLine.mutate({
        deliveryId: draft.id,
        purchaseItemId,
        qty,
      }),
    );
    if (ok) await refetch();
  }

  async function commitCheck() {
    if (!draft) return;
    if (!confirm("Commit this receiving check? Stock will be received.")) return;
    const ok = await run("Receiving check", () =>
      CommitReceivingCheck.mutate({ deliveryId: draft.id }),
    );
    if (ok) await refetch();
  }

  async function applyScan() {
    if (!purchase || !scanCode.trim()) return;
    const code = scanCode.trim();
    busy = true;
    feedback = null;
    lastScanHit = null;
    try {
      const res = await ResolveScan.fetch({
        variables: { purchaseId: purchase.id, code },
      });
      const hits = res.data?.resolveReceivingScan ?? [];
      if (hits.length === 0) {
        feedback = { ok: false, text: `No line matches "${code}".` };
        return;
      }
      if (hits.length > 1) {
        feedback = {
          ok: false,
          text: `"${code}" matches ${hits.length} lines — increment manually.`,
        };
        return;
      }
      const hit = hits[0].id;
      lastScanHit = hit;
      // Auto-increment the staged qty on a single-line scan, then save it.
      const next = (qtyDrafts[hit] ?? 0) + 1;
      qtyDrafts[hit] = next;
      scanCode = "";
      // Save without re-entering the busy guard.
      if (draft) {
        const r = await SetReceivingCheckLine.mutate({
          deliveryId: draft.id,
          purchaseItemId: hit,
          qty: next,
        });
        if (r.errors?.length) {
          feedback = { ok: false, text: r.errors[0].message };
        } else {
          const matched = lines.find((l) => l.purchaseItem.id === hit);
          const name = variantLabel(
            matched?.purchaseItem.variantId,
            matched?.purchaseItem.description,
          );
          feedback = { ok: true, text: `+1 to ${name}` };
        }
      }
      await refetch();
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
    } finally {
      busy = false;
    }
  }

  const statusClass = (s: string) =>
    s === "complete"
      ? "bg-emerald-100 text-emerald-700"
      : s === "partial"
        ? "bg-amber-100 text-amber-800"
        : "bg-muted text-muted-foreground";

  const fmtDate = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleDateString("id-ID") : "—";
</script>

<svelte:head>
  <title>
    Receiving · {purchase ? purchase.snapshotVendorName : "Purchase"} · Retale
    Console
  </title>
</svelte:head>

<div class="mx-auto max-w-3xl space-y-6">
  <a
    href="/purchases/{page.params.id}"
    class="text-sm text-muted-foreground hover:text-foreground"
  >
    ← Back to purchase
  </a>

  {#if $ReceivingCheck.fetching && !purchase}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if !purchase}
    <p class="text-sm text-destructive">Purchase not found.</p>
  {:else}
    <div class="flex items-start justify-between gap-4">
      <div>
        <h1 class="text-xl font-semibold">
          Receive goods · {purchase.snapshotVendorName}
        </h1>
        <p class="text-sm text-muted-foreground">
          {fmtDate(purchase.date)}
        </p>
      </div>
      {#if draft}
        <Badge class="bg-sky-100 text-sky-700">draft check open</Badge>
      {/if}
    </div>

    {#if feedback}
      <p class="text-sm {feedback.ok ? 'text-emerald-700' : 'text-destructive'}">
        {feedback.text}
      </p>
    {/if}

    {#if !canDraft}
      <p
        class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
      >
        You don't have permission to draft receiving checks.
      </p>
    {:else if purchase.status === "cancelled"}
      <p
        class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
      >
        This purchase is cancelled — receiving is closed.
      </p>
    {:else if purchase.status === "complete"}
      <p
        class="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
      >
        This purchase is fully received — nothing left to receive.
      </p>
    {:else if !draft}
      <!-- Start panel -->
      <section class="space-y-3 rounded-lg border bg-card p-5">
        <h2 class="text-sm font-semibold">Start a receiving check</h2>
        <p class="text-sm text-muted-foreground">
          Goods received here are added to the chosen location's stock on
          commit.
        </p>
        <div class="flex items-end gap-2">
          <label class="space-y-1">
            <span class="text-xs font-medium">Target location</span>
            <Select bind:value={startLocationId}>
              {#each locations as l (l.id)}
                <option value={l.id}>{l.name}</option>
              {/each}
            </Select>
          </label>
          <Button
            disabled={busy || !startLocationId || locations.length === 0}
            onclick={startCheck}>Start check</Button
          >
        </div>
        {#if locations.length === 0}
          <p class="text-xs text-destructive">
            No active locations — create one first.
          </p>
        {/if}
      </section>
    {:else}
      <!-- Draft is open: scan + lines + commit -->
      <section class="space-y-3 rounded-lg border bg-card p-5">
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-semibold">
            Open check · {draft.targetLocation?.name ?? "—"}
          </h2>
          <Button
            size="sm"
            disabled={busy || !canCommit}
            onclick={commitCheck}>Commit check</Button
          >
        </div>
        {#if !canCommit}
          <p class="text-xs text-muted-foreground">
            You can stage counts; a viewer with delivery.commit must commit.
          </p>
        {/if}

        <!-- Scan row -->
        <form
          class="flex items-end gap-2"
          onsubmit={(e) => {
            e.preventDefault();
            applyScan();
          }}
        >
          <label class="flex-1 space-y-1">
            <span class="text-xs font-medium">Scan / type a code</span>
            <Input
              bind:value={scanCode}
              placeholder="Barcode, SKU, or vendor code"
              autofocus
            />
          </label>
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={busy || !scanCode.trim()}>+1</Button
          >
        </form>
      </section>

      <section class="space-y-3 rounded-lg border bg-card p-5">
        <h2 class="text-sm font-semibold">Lines ({lines.length})</h2>
        <table class="w-full text-sm">
          <thead class="border-b text-left text-muted-foreground">
            <tr>
              <th class="py-1.5 font-medium">Line</th>
              <th class="py-1.5 text-right font-medium">Ordered</th>
              <th class="py-1.5 text-right font-medium">Delivered</th>
              <th class="py-1.5 text-right font-medium">Remaining</th>
              <th class="py-1.5 text-right font-medium">In check</th>
              <th class="py-1.5 font-medium">After commit</th>
            </tr>
          </thead>
          <tbody>
            {#each lines as l (l.purchaseItem.id)}
              <tr
                class="border-b last:border-0
                  {lastScanHit === l.purchaseItem.id ? 'bg-emerald-50' : ''}"
              >
                <td class="py-1.5">
                  {variantLabel(
                    l.purchaseItem.variantId,
                    l.purchaseItem.description,
                  )}
                </td>
                <td class="py-1.5 text-right">{l.qtyOrdered}</td>
                <td class="py-1.5 text-right">{l.qtyDelivered}</td>
                <td class="py-1.5 text-right">{l.remaining}</td>
                <td class="py-1.5 text-right">
                  <Input
                    type="number"
                    min="0"
                    class="w-20 text-right"
                    value={qtyDrafts[l.purchaseItem.id] ?? 0}
                    oninput={(e) => {
                      const v = (e.currentTarget as HTMLInputElement)
                        .valueAsNumber;
                      qtyDrafts[l.purchaseItem.id] = Number.isNaN(v) ? 0 : v;
                    }}
                    onblur={() => {
                      if (qtyDrafts[l.purchaseItem.id] !== l.qtyInCheck) {
                        saveLine(l.purchaseItem.id);
                      }
                    }}
                  />
                </td>
                <td class="py-1.5">
                  <Badge class={statusClass(l.provisionalStatus)}>
                    {l.provisionalStatus}
                  </Badge>
                </td>
              </tr>
            {/each}
            {#if lines.length === 0}
              <tr>
                <td colspan="6" class="py-6 text-center text-muted-foreground">
                  This purchase has no lines.
                </td>
              </tr>
            {/if}
          </tbody>
        </table>
        <p class="text-xs text-muted-foreground">
          Edits save when the field loses focus. Scanning a code increments the
          matching line by 1.
        </p>
      </section>
    {/if}
  {/if}
</div>
