<script lang="ts">
  import { CachePolicy, graphql } from "$houdini";
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import type { Viewer } from "../+layout.server";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import Pagination from "$lib/components/ui/pagination.svelte";
  import type { PageData } from "./$types";

  graphql(`
    query AlertsInbox($acknowledged: Boolean) {
      productAlerts(acknowledged: $acknowledged) {
        id
        productId
        product { id name }
        type
        triggeredAt
        triggerContext
        acknowledgedAt
        resolutionNote
      }
      purchaseAlerts(acknowledged: $acknowledged) {
        id
        purchaseId
        purchase { id snapshotVendorName }
        type
        triggeredAt
        triggerContext
        acknowledgedAt
        resolutionNote
      }
    }
  `);

  const ScanProductAlerts = graphql(`
    mutation ConsoleScanProductAlerts {
      scanProductAlerts { id }
    }
  `);

  const ScanDeliveryOverdue = graphql(`
    mutation ConsoleScanDeliveryOverdue {
      scanDeliveryOverdue { id }
    }
  `);

  const ScanSendDue = graphql(`
    mutation ConsoleScanSendDue {
      scanSendDue { id }
    }
  `);

  const AckProductAlert = graphql(`
    mutation ConsoleAckProductAlert($id: ID!, $resolutionNote: String) {
      acknowledgeProductAlert(id: $id, resolutionNote: $resolutionNote) {
        id
        acknowledgedAt
      }
    }
  `);

  const AckPurchaseAlert = graphql(`
    mutation ConsoleAckPurchaseAlert($id: ID!, $resolutionNote: String) {
      acknowledgePurchaseAlert(id: $id, resolutionNote: $resolutionNote) {
        id
        acknowledgedAt
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const Inbox = $derived(data.AlertsInbox);
  const productAlerts = $derived($Inbox.data?.productAlerts ?? []);
  const purchaseAlerts = $derived($Inbox.data?.purchaseAlerts ?? []);

  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canAck = $derived(has("alert.acknowledge"));
  // Scans reuse the product / purchase edit permissions on the API side.
  const canScanProduct = $derived(has("product.edit"));
  const canScanPurchase = $derived(has("purchase.edit"));

  let showAcked = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let info = $state<string | null>(null);

  let productAlertsPage = $state(1);
  let purchaseAlertsPage = $state(1);
  const pageSize = 50;

  $effect(() => {
    showAcked;
    productAlertsPage = 1;
    purchaseAlertsPage = 1;
  });

  const paginatedProductAlerts = $derived(productAlerts.slice((productAlertsPage - 1) * pageSize, productAlertsPage * pageSize));
  const paginatedPurchaseAlerts = $derived(purchaseAlerts.slice((purchaseAlertsPage - 1) * pageSize, purchaseAlertsPage * pageSize));

  async function toggleHistory() {
    showAcked = !showAcked;
    await Inbox.fetch({
      // null fetches every alert; false → only unacknowledged.
      variables: { acknowledged: showAcked ? null : false },
    });
  }

  async function refresh() {
    // NetworkOnly: a scan/ack just changed the alert set server-side, so the
    // cached list is stale — go to the network or the screen won't update.
    await Inbox.fetch({
      variables: { acknowledged: showAcked ? null : false },
      policy: CachePolicy.NetworkOnly,
    });
  }

  async function scanProduct({ silent = false }: { silent?: boolean } = {}) {
    busy = true;
    error = null;
    if (!silent) info = null;
    try {
      const res = await ScanProductAlerts.mutate(null);
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      if (!silent)
        info = `Product scan raised ${res.data?.scanProductAlerts.length ?? 0} new alert(s).`;
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  // `silent` is used by the on-load auto-scan: it still raises + refreshes, but
  // skips the "raised N new alert(s)" banner so a routine visit stays quiet.
  async function scanPurchases({ silent = false }: { silent?: boolean } = {}) {
    busy = true;
    error = null;
    if (!silent) info = null;
    try {
      const [overdue, sendDue] = await Promise.all([
        ScanDeliveryOverdue.mutate(null),
        ScanSendDue.mutate(null),
      ]);
      const overdueErr = overdue.errors?.[0]?.message;
      const sendErr = sendDue.errors?.[0]?.message;
      if (overdueErr || sendErr) {
        error = overdueErr ?? sendErr ?? "Scan failed.";
        return;
      }
      const n =
        (overdue.data?.scanDeliveryOverdue.length ?? 0) +
        (sendDue.data?.scanSendDue.length ?? 0);
      if (!silent) info = `Purchase scan raised ${n} new alert(s).`;
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  // Run both scans whenever the inbox opens, so margin / send-due / overdue
  // alerts surface without waiting for the nightly job or a manual click.
  onMount(() => {
    if (canScanPurchase) scanPurchases({ silent: true });
    if (canScanProduct) scanProduct({ silent: true });
  });

  // ---- Per-row acknowledge -------------------------------------------------
  // ackingId tracks which row is showing its inline note field — null means
  // none. We don't need a separate note per row at the same time because the
  // form is exclusive.
  let ackingId = $state<string | null>(null);
  let ackNote = $state("");

  async function ackProduct(id: string) {
    busy = true;
    error = null;
    try {
      const res = await AckProductAlert.mutate({
        id,
        resolutionNote: ackNote.trim() || null,
      });
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      ackingId = null;
      ackNote = "";
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function ackPurchase(id: string) {
    busy = true;
    error = null;
    try {
      const res = await AckPurchaseAlert.mutate({
        id,
        resolutionNote: ackNote.trim() || null,
      });
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      ackingId = null;
      ackNote = "";
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  const fmtDateTime = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleString("id-ID") : "—";

  function typeBadge(t: string) {
    if (t.includes("negative") || t === "delivery_overdue") {
      return "bg-destructive/10 text-destructive";
    }
    return "bg-amber-100 text-amber-800";
  }

  // Render the JSON trigger context as a compact key:value list.
  function summary(json: string | null | undefined): string {
    if (!json) return "";
    try {
      const v = JSON.parse(json) as Record<string, unknown>;
      return Object.entries(v)
        .map(([k, val]) => `${k}: ${typeof val === "object" ? JSON.stringify(val) : val}`)
        .join(" · ");
    } catch {
      return json;
    }
  }
</script>

<svelte:head><title>Alerts · Retale Console</title></svelte:head>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <h1 class="text-xl font-semibold">Alerts</h1>
    <div class="flex items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={busy || !canScanProduct}
        onclick={() => scanProduct()}>Scan products</Button
      >
      <Button
        size="sm"
        variant="outline"
        disabled={busy || !canScanPurchase}
        onclick={() => scanPurchases()}>Scan purchases</Button
      >
      <Button size="sm" variant="ghost" onclick={toggleHistory}>
        {showAcked ? "Hide acknowledged" : "Show acknowledged"}
      </Button>
    </div>
  </div>

  {#if error}
    <p class="text-sm text-destructive">{error}</p>
  {/if}
  {#if info}
    <p class="text-sm text-emerald-700">{info}</p>
  {/if}

  {#if $Inbox.fetching && productAlerts.length + purchaseAlerts.length === 0}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if $Inbox.errors?.length}
    <p class="text-sm text-destructive">{$Inbox.errors[0].message}</p>
  {:else}
    <!-- Product alerts -->
    <section>
      <h2 class="mb-2 text-sm font-semibold">
        Product alerts
        <span class="ml-1 text-xs font-normal text-muted-foreground">
          ({productAlerts.length})
        </span>
      </h2>
      <div class="overflow-hidden rounded-lg border bg-card">
        <table class="w-full text-sm">
          <thead class="border-b bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th class="min-w-48 px-4 py-2 font-medium">Product</th>
              <th class="px-4 py-2 font-medium">Type</th>
              <th class="px-4 py-2 font-medium">Triggered</th>
              <th class="px-4 py-2 font-medium">Context</th>
              <th class="px-4 py-2 font-medium">Status</th>
              <th class="px-4 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {#each paginatedProductAlerts as a (a.id)}
              <tr
                class="border-b last:border-0 align-top
                  {a.acknowledgedAt ? 'text-muted-foreground' : ''}"
              >
                <td class="px-4 py-2">
                  {#if a.product}
                    <a
                      href={`/products/${a.product.id}`}
                      class="font-medium text-primary hover:underline"
                    >
                      {a.product.name}
                    </a>
                  {:else}
                    <span class="font-mono text-xs">{a.productId.slice(-8)}</span>
                  {/if}
                </td>
                <td class="px-4 py-2">
                  <Badge class={typeBadge(a.type)}>
                    {a.type.replace("_", " ")}
                  </Badge>
                </td>
                <td class="whitespace-nowrap px-4 py-2">{fmtDateTime(a.triggeredAt)}</td>
                <td class="px-4 py-2 text-xs text-muted-foreground">
                  <!-- The inner cap keeps a long context dump from starving the
                       product column under the table's auto layout. -->
                  <div class="max-w-md break-words">
                    {summary(a.triggerContext) || "—"}
                  </div>
                </td>
                <td class="px-4 py-2">
                  {#if a.acknowledgedAt}
                    <Badge class="bg-emerald-100 text-emerald-700">acked</Badge>
                    {#if a.resolutionNote}
                      <p class="mt-1 text-xs">{a.resolutionNote}</p>
                    {/if}
                  {:else}
                    <Badge class="bg-amber-100 text-amber-800">open</Badge>
                  {/if}
                </td>
                <td class="px-4 py-2 text-right">
                  {#if !a.acknowledgedAt && canAck}
                    {#if ackingId === a.id}
                      <div class="flex items-center gap-1">
                        <Input
                          bind:value={ackNote}
                          placeholder="Resolution note (optional)"
                          class="w-56"
                        />
                        <Button
                          size="sm"
                          disabled={busy}
                          onclick={() => ackProduct(a.id)}>Ack</Button
                        >
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onclick={() => {
                            ackingId = null;
                            ackNote = "";
                          }}>×</Button
                        >
                      </div>
                    {:else}
                      <Button
                        size="sm"
                        variant="outline"
                        onclick={() => {
                          ackingId = a.id;
                          ackNote = "";
                        }}>Acknowledge</Button
                      >
                    {/if}
                  {/if}
                </td>
              </tr>
            {/each}
            {#if productAlerts.length === 0}
              <tr>
                <td colspan="6" class="px-4 py-6 text-center text-muted-foreground">
                  No product alerts.
                </td>
              </tr>
            {/if}
          </tbody>
        </table>
      </div>
      <div class="mt-2 flex justify-end">
        <Pagination bind:page={productAlertsPage} {pageSize} totalItems={productAlerts.length} />
      </div>
    </section>

    <!-- Purchase alerts -->
    <section>
      <h2 class="mb-2 text-sm font-semibold">
        Purchase alerts
        <span class="ml-1 text-xs font-normal text-muted-foreground">
          ({purchaseAlerts.length})
        </span>
      </h2>
      <div class="overflow-hidden rounded-lg border bg-card">
        <table class="w-full text-sm">
          <thead class="border-b bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th class="min-w-48 px-4 py-2 font-medium">PO</th>
              <th class="px-4 py-2 font-medium">Type</th>
              <th class="px-4 py-2 font-medium">Triggered</th>
              <th class="px-4 py-2 font-medium">Context</th>
              <th class="px-4 py-2 font-medium">Status</th>
              <th class="px-4 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {#each paginatedPurchaseAlerts as a (a.id)}
              <tr
                class="border-b last:border-0 align-top
                  {a.acknowledgedAt ? 'text-muted-foreground' : ''}"
              >
                <td class="px-4 py-2">
                  <a
                    href={`/purchases/${a.purchaseId}`}
                    class="font-mono text-xs text-primary hover:underline"
                  >
                    {a.purchase?.snapshotVendorName ?? a.purchaseId.slice(-8)}
                  </a>
                </td>
                <td class="px-4 py-2">
                  <Badge class={typeBadge(a.type)}>
                    {a.type.replace("_", " ")}
                  </Badge>
                </td>
                <td class="whitespace-nowrap px-4 py-2">{fmtDateTime(a.triggeredAt)}</td>
                <td class="px-4 py-2 text-xs text-muted-foreground">
                  <div class="max-w-md break-words">
                    {summary(a.triggerContext) || "—"}
                  </div>
                </td>
                <td class="px-4 py-2">
                  {#if a.acknowledgedAt}
                    <Badge class="bg-emerald-100 text-emerald-700">acked</Badge>
                    {#if a.resolutionNote}
                      <p class="mt-1 text-xs">{a.resolutionNote}</p>
                    {/if}
                  {:else}
                    <Badge class="bg-amber-100 text-amber-800">open</Badge>
                  {/if}
                </td>
                <td class="px-4 py-2 text-right">
                  {#if !a.acknowledgedAt && canAck}
                    {#if ackingId === a.id}
                      <div class="flex items-center gap-1">
                        <Input
                          bind:value={ackNote}
                          placeholder="Resolution note (optional)"
                          class="w-56"
                        />
                        <Button
                          size="sm"
                          disabled={busy}
                          onclick={() => ackPurchase(a.id)}>Ack</Button
                        >
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onclick={() => {
                            ackingId = null;
                            ackNote = "";
                          }}>×</Button
                        >
                      </div>
                    {:else}
                      <Button
                        size="sm"
                        variant="outline"
                        onclick={() => {
                          ackingId = a.id;
                          ackNote = "";
                        }}>Acknowledge</Button
                      >
                    {/if}
                  {/if}
                </td>
              </tr>
            {/each}
            {#if purchaseAlerts.length === 0}
              <tr>
                <td colspan="6" class="px-4 py-6 text-center text-muted-foreground">
                  No purchase alerts.
                </td>
              </tr>
            {/if}
          </tbody>
        </table>
      </div>
      <div class="mt-2 flex justify-end">
        <Pagination bind:page={purchaseAlertsPage} {pageSize} totalItems={purchaseAlerts.length} />
      </div>
    </section>
  {/if}
</div>
