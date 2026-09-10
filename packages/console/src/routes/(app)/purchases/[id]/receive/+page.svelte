<script lang="ts">
  import NumericInput from "$lib/components/ui/numeric-input.svelte";
  import { CachePolicy, graphql } from "$houdini";
  import { page } from "$app/state";
  import type { Viewer } from "../../../+layout.server";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Combobox from "$lib/components/ui/combobox.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import { treePathMap } from "$lib/utils";
  import { t } from "$lib/i18n";
  import type { PageData } from "./$types";

  // The receiving state that changes as the check is worked: purchase header
  // (context + line metadata), openReceivingCheck (draft existence) and
  // receivingCheckLines (the working grid). This is all refetch() re-pulls.
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
    }
  `);

  // Static lookups: locations (target picker) + catalog (line labels). Neither
  // depends on the receiving state, so they live in their own query and load
  // once — keeping them out of the per-line-save refetch().
  graphql(`
    query ReceivingRefData {
      locations(includeArchived: false) {
        id
        name
        parentId
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
  const RefData = $derived(data.ReceivingRefData);
  const purchase = $derived($ReceivingCheck.data?.purchase);
  const draft = $derived($ReceivingCheck.data?.openReceivingCheck);
  const lines = $derived($ReceivingCheck.data?.receivingCheckLines ?? []);
  const locations = $derived($RefData.data?.locations ?? []);
  // Breadcrumb path per location ("Shelf 2 › Level 1") so same-named children
  // under different parents are distinguishable.
  const locationPaths = $derived(treePathMap(locations));
  const locationOptions = $derived(
    locations.map((l) => ({ value: l.id, label: locationPaths.get(l.id) ?? l.name })),
  );
  const products = $derived($RefData.data?.products ?? []);

  // Flat variant lookup so the lines grid can label by product name /
  // variant label (foreground) with only the machine SKU muted.
  const variantParts = $derived.by(() => {
    const m = new Map<string, { name: string; sku: string; label: string | null }>();
    for (const p of products) {
      for (const v of p.variants) {
        m.set(v.id, { name: p.name, sku: v.sku, label: v.label ?? null });
      }
    }
    return m;
  });
  const variantLabel = $derived.by(() => {
    const m = new Map<string, string>();
    for (const p of products) {
      for (const v of p.variants) {
        const suffix = v.label ? `${v.sku} · ${v.label}` : v.sku;
        m.set(v.id, `${p.name} · ${suffix}`);
      }
    }
    return (id: string | null | undefined, fallback: string | null | undefined) =>
      id ? (m.get(id) ?? fallback ?? t("products.unknown")) : (fallback ?? "—");
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
      feedback = { ok: true, text: label };
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
    const ok = await run(t("purchaseReceive.savedCheck"), () =>
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
      feedback = { ok: false, text: t("purchaseReceive.errorQty") };
      return;
    }
    const ok = await run(t("purchaseReceive.savedLine"), () =>
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
    if (!confirm(t("purchaseReceive.confirmCommit"))) return;
    const ok = await run(t("purchaseReceive.savedCheck"), () =>
      CommitReceivingCheck.mutate({ deliveryId: draft.id }),
    );
    if (ok) await refetch();
  }

  // True while any line still has stock owed — the Fill button's enable gate.
  const hasRemaining = $derived(lines.some((l) => l.remaining > 0));

  /**
   * Stage every line's full remaining qty in one go — the "received the whole
   * shipment" shortcut, so the clerk commits without typing each line. Lines
   * already at their remaining (or with nothing owed) are skipped.
   */
  async function fillAllRemaining() {
    if (!draft) return;
    busy = true;
    feedback = null;
    try {
      let filled = 0;
      for (const l of lines) {
        if (l.remaining <= 0 || qtyDrafts[l.purchaseItem.id] === l.remaining) {
          continue;
        }
        qtyDrafts[l.purchaseItem.id] = l.remaining;
        const r = await SetReceivingCheckLine.mutate({
          deliveryId: draft.id,
          purchaseItemId: l.purchaseItem.id,
          qty: l.remaining,
        });
        if (r.errors?.length) {
          feedback = { ok: false, text: r.errors[0].message };
          return;
        }
        filled++;
      }
      feedback = {
        ok: true,
        text: filled
          ? t("purchaseReceive.filledLines", { count: filled })
          : t("purchaseReceive.allFilled"),
      };
      await refetch();
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
    } finally {
      busy = false;
    }
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
        feedback = { ok: false, text: t("purchaseReceive.noLineMatches", { code }) };
        return;
      }
      if (hits.length > 1) {
        feedback = {
          ok: false,
          text: t("purchaseReceive.multipleMatches", { code, count: hits.length }),
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
          feedback = { ok: true, text: t("purchaseReceive.scanAdded", { name }) };
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
    iso ? new Date(iso).toLocaleDateString("en-CA") : "—";
</script>

<svelte:head>
  <title>
    {t("purchaseReceive.receiving")} · {purchase ? purchase.snapshotVendorName : t("purchaseReceive.purchase")} · Retale
    Console
  </title>
</svelte:head>

<div class="mx-auto max-w-5xl space-y-6">
  <a
    href="/purchases/{page.params.id}"
    class="text-sm text-muted-foreground hover:text-foreground"
  >
    {t("purchaseReceive.backToPurchase")}
  </a>

  {#if $ReceivingCheck.fetching && !purchase}
    <p class="text-sm text-muted-foreground">{t("common.loading")}</p>
  {:else if !purchase}
    <p class="text-sm text-destructive">{t("purchaseDetail.notFound")}</p>
  {:else}
    <div class="flex items-start justify-between gap-4">
      <div>
        <h1 class="text-xl font-semibold">
          {t("purchaseReceive.receiveGoods", { name: purchase.snapshotVendorName })}
        </h1>
        <p class="text-sm text-muted-foreground">
          {fmtDate(purchase.date)}
        </p>
      </div>
      {#if draft}
        <Badge class="bg-sky-100 text-sky-700">{t("purchaseReceive.draftCheckOpen")}</Badge>
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
        {t("purchaseReceive.noDraftPermission")}
      </p>
    {:else if purchase.status === "cancelled"}
      <p
        class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
      >
        {t("purchaseReceive.cancelledReceivingClosed")}
      </p>
    {:else if purchase.status === "complete"}
      <p
        class="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
      >
        {t("purchaseReceive.fullyReceived")}
      </p>
    {:else if !draft}
      <!-- Start panel -->
      <section class="space-y-3 rounded-lg border bg-card p-5">
        <h2 class="text-sm font-semibold">{t("purchaseReceive.startCheckTitle")}</h2>
        <p class="text-sm text-muted-foreground">
          {t("purchaseReceive.startCheckHint")}
        </p>
        <div class="flex items-end gap-2">
          <label class="space-y-1 w-56">
            <span class="text-xs font-medium">{t("purchaseReceive.targetLocation")}</span>
            <Combobox
              options={locationOptions}
              bind:value={startLocationId}
              placeholder={t("purchaseReceive.searchLocation")}
            />
          </label>
          <Button
            disabled={busy || !startLocationId || locations.length === 0}
            onclick={startCheck}>{t("purchaseReceive.startCheck")}</Button
          >
        </div>
        {#if locations.length === 0}
          <p class="text-xs text-destructive">
            {t("purchaseReceive.noActiveLocations")}
          </p>
        {/if}
      </section>
    {:else}
      <!-- Draft is open: scan + lines + commit -->
      <section class="space-y-3 rounded-lg border bg-card p-5">
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-semibold">
            {t("purchaseReceive.openCheck", { name: draft.targetLocation?.name ?? "—" })}
          </h2>
          <div class="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !hasRemaining}
              onclick={fillAllRemaining}>{t("purchaseReceive.fillAllRemaining")}</Button
            >
            <Button
              size="sm"
              disabled={busy || !canCommit}
              onclick={commitCheck}>{t("purchaseReceive.commitCheck")}</Button
            >
          </div>
        </div>
        {#if !canCommit}
          <p class="text-xs text-muted-foreground">
            {t("purchaseReceive.stageHint")}
          </p>
        {/if}
        <p class="text-xs text-muted-foreground">
          {t("purchaseReceive.freightHintBefore")}
          <a href={`/deliveries/${draft.id}`} class="text-primary hover:underline">
            {t("purchaseReceive.freightHintLink")}
          </a>
          {t("purchaseReceive.freightHintAfter")}
        </p>

        <!-- Scan row -->
        <form
          class="flex items-end gap-2"
          onsubmit={(e) => {
            e.preventDefault();
            applyScan();
          }}
        >
          <label class="flex-1 space-y-1">
            <span class="text-xs font-medium">{t("purchaseReceive.scanTypeCode")}</span>
            <Input
              bind:value={scanCode}
              placeholder={t("purchaseReceive.barcodePlaceholder")}
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
        <h2 class="text-sm font-semibold">{t("purchaseReceive.lines", { count: lines.length })}</h2>
        <table class="w-full text-sm">
          <thead class="border-b text-left text-muted-foreground">
            <tr>
              <th class="px-4 py-2 font-medium">{t("purchases.line")}</th>
              <th class="px-4 py-2 text-right font-medium">{t("purchases.ordered")}</th>
              <th class="px-4 py-2 text-right font-medium">{t("purchases.delivered")}</th>
              <th class="px-4 py-2 text-right font-medium">{t("purchases.remaining")}</th>
              <th class="px-4 py-2 text-right font-medium">{t("purchaseReceive.inCheck")}</th>
              <th class="px-4 py-2 font-medium">{t("purchaseReceive.afterCommit")}</th>
            </tr>
          </thead>
          <tbody>
            {#each lines as l (l.purchaseItem.id)}
              {@const vp = l.purchaseItem.variantId ? variantParts.get(l.purchaseItem.variantId) : undefined}
              <tr
                class="border-b last:border-0
                  {lastScanHit === l.purchaseItem.id
                  ? 'bg-emerald-50'
                  : 'even:bg-muted/40'}"
              >
                <td class="px-4 py-2">
                  {#if vp}
                    {vp.name}{#if vp.label}<span class="ml-1.5 font-medium text-foreground">· {vp.label}</span>{/if}<span class="ml-1.5 font-mono text-xs text-muted-foreground">({vp.sku})</span>
                  {:else}
                    {variantLabel(
                      l.purchaseItem.variantId,
                      l.purchaseItem.description,
                    )}
                  {/if}
                </td>
                <td class="px-4 py-2 text-right tabular-nums">{l.qtyOrdered}</td>
                <td class="px-4 py-2 text-right tabular-nums">{l.qtyDelivered}</td>
                <td class="px-4 py-2 text-right tabular-nums">{l.remaining}</td>
                <td class="px-4 py-2 text-right">
                  <NumericInput
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
                <td class="px-4 py-2">
                  <Badge class={statusClass(l.provisionalStatus)}>
                    {t(`purchaseReceive.status.${l.provisionalStatus}`)}
                  </Badge>
                </td>
              </tr>
            {/each}
            {#if lines.length === 0}
              <tr>
                <td colspan="6" class="py-6 text-center text-muted-foreground">
                  {t("purchaseReceive.noLines")}
                </td>
              </tr>
            {/if}
          </tbody>
        </table>
        <p class="text-xs text-muted-foreground">
          {t("purchaseReceive.editsSaveHint")}
        </p>
      </section>
    {/if}
  {/if}
</div>
