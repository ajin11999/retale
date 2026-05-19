<script lang="ts">
  import { graphql } from "$houdini";
  import { page } from "$app/state";
  import type { Viewer } from "../../+layout.server";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import type { PageData } from "./$types";

  // Query document — Houdini scans this for codegen. The live store is
  // supplied by +page.ts through `data` (route-store wiring is unavailable).
  graphql(`
    query TransferDetail($id: ID!) {
      stockTransfer(id: $id) {
        id
        sourceLocationId
        targetLocationId
        status
        notes
        dispatchedAt
        receivedAt
        cancelledAt
        cancellationReason
        createdAt
        items {
          id
          variantId
          qty
        }
      }
      locations {
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

  const DispatchTransfer = graphql(`
    mutation ConsoleDispatchStockTransfer($id: ID!) {
      dispatchStockTransfer(id: $id) {
        id
        status
      }
    }
  `);

  const ReceiveTransfer = graphql(`
    mutation ConsoleReceiveStockTransfer($id: ID!) {
      receiveStockTransfer(id: $id) {
        id
        status
      }
    }
  `);

  const CancelTransfer = graphql(`
    mutation ConsoleCancelStockTransfer($id: ID!, $reason: String!) {
      cancelStockTransfer(id: $id, reason: $reason) {
        id
        status
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const TransferDetail = $derived(data.TransferDetail);
  const transfer = $derived($TransferDetail.data?.stockTransfer);
  const locations = $derived($TransferDetail.data?.locations ?? []);
  const products = $derived($TransferDetail.data?.products ?? []);

  const locationName = (id: string) =>
    locations.find((l) => l.id === id)?.name ?? "Unknown";

  const variantLabel = (id: string) => {
    for (const p of products) {
      const v = p.variants.find((x) => x.id === id);
      if (v) {
        const suffix = v.label ? `${v.sku} · ${v.label}` : v.sku;
        return `${p.name} · ${suffix}`;
      }
    }
    return "Unknown variant";
  };

  // ---- Viewer permissions --------------------------------------------------
  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canDispatch = $derived(has("stock.transfer.dispatch"));
  const canReceive = $derived(has("stock.transfer.receive"));
  const canCancel = $derived(has("stock.transfer.cancel"));

  let busy = $state(false);
  let feedback = $state<{ ok: boolean; text: string } | null>(null);

  /** Run a mutation, surfacing the first GraphQL error as feedback. */
  async function run(
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
      return true;
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
      return false;
    } finally {
      busy = false;
    }
  }

  const refetch = () =>
    transfer && TransferDetail.fetch({ variables: { id: transfer.id } });

  async function dispatch() {
    if (!transfer) return;
    if (
      !confirm("Dispatch this transfer? Stock leaves the source location now.")
    )
      return;
    if (await run(() => DispatchTransfer.mutate({ id: transfer.id }))) {
      feedback = { ok: true, text: "Transfer dispatched." };
      await refetch();
    }
  }

  async function receive() {
    if (!transfer) return;
    if (
      !confirm("Receive this transfer? Stock lands at the target location now.")
    )
      return;
    if (await run(() => ReceiveTransfer.mutate({ id: transfer.id }))) {
      feedback = { ok: true, text: "Transfer received." };
      await refetch();
    }
  }

  async function cancel() {
    if (!transfer) return;
    const reason = prompt("Cancellation reason:");
    if (reason === null) return;
    if (!reason.trim()) {
      feedback = { ok: false, text: "A cancellation reason is required." };
      return;
    }
    if (
      await run(() =>
        CancelTransfer.mutate({ id: transfer.id, reason: reason.trim() }),
      )
    ) {
      feedback = { ok: true, text: "Transfer cancelled." };
      await refetch();
    }
  }

  const statusClass = (s: string) =>
    s === "draft"
      ? "bg-muted text-muted-foreground"
      : s === "in_transit"
        ? "bg-sky-100 text-sky-700"
        : s === "received"
          ? "bg-emerald-100 text-emerald-700"
          : "bg-amber-100 text-amber-800";
  const fmtDateTime = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleString("id-ID") : "—";
</script>

<svelte:head><title>Transfer · Retale Console</title></svelte:head>

<div class="mx-auto max-w-2xl space-y-6">
  <a
    href="/transfers"
    class="text-sm text-muted-foreground hover:text-foreground"
    >← Back to transfers</a
  >

  {#if $TransferDetail.fetching && !transfer}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if !transfer}
    <p class="text-sm text-destructive">Transfer not found.</p>
  {:else}
    <div class="flex items-start justify-between gap-4">
      <div>
        <h1 class="text-xl font-semibold">
          {locationName(transfer.sourceLocationId)} →
          {locationName(transfer.targetLocationId)}
        </h1>
        <p class="text-sm text-muted-foreground">
          Created {fmtDateTime(transfer.createdAt)}
        </p>
      </div>
      <Badge class={statusClass(transfer.status)}>{transfer.status}</Badge>
    </div>

    {#if feedback}
      <p class="text-sm {feedback.ok ? 'text-emerald-700' : 'text-destructive'}">
        {feedback.text}
      </p>
    {/if}

    <!-- Lifecycle actions -->
    <div class="flex gap-2">
      {#if transfer.status === "draft"}
        <Button size="sm" disabled={busy || !canDispatch} onclick={dispatch}>
          Dispatch
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !canCancel}
          onclick={cancel}>Cancel</Button
        >
      {:else if transfer.status === "in_transit"}
        <Button size="sm" disabled={busy || !canReceive} onclick={receive}>
          Receive
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !canCancel}
          onclick={cancel}>Cancel</Button
        >
      {:else}
        <p class="text-sm text-muted-foreground">
          This transfer is {transfer.status} — no further actions.
        </p>
      {/if}
    </div>

    <!-- Timeline -->
    <section class="space-y-1 rounded-lg border bg-card p-5 text-sm">
      <h2 class="mb-2 text-sm font-semibold">Timeline</h2>
      <div class="flex justify-between">
        <span class="text-muted-foreground">Dispatched</span>
        <span>{fmtDateTime(transfer.dispatchedAt)}</span>
      </div>
      <div class="flex justify-between">
        <span class="text-muted-foreground">Received</span>
        <span>{fmtDateTime(transfer.receivedAt)}</span>
      </div>
      {#if transfer.cancelledAt}
        <div class="flex justify-between">
          <span class="text-muted-foreground">Cancelled</span>
          <span>{fmtDateTime(transfer.cancelledAt)}</span>
        </div>
        {#if transfer.cancellationReason}
          <p class="pt-1 text-muted-foreground">
            Reason: {transfer.cancellationReason}
          </p>
        {/if}
      {/if}
      {#if transfer.notes}
        <p class="pt-1 text-muted-foreground">Notes: {transfer.notes}</p>
      {/if}
    </section>

    <!-- Lines -->
    <section class="space-y-3 rounded-lg border bg-card p-5">
      <h2 class="text-sm font-semibold">Lines ({transfer.items.length})</h2>
      <table class="w-full text-sm">
        <thead class="border-b text-left text-muted-foreground">
          <tr>
            <th class="py-1.5 font-medium">Variant</th>
            <th class="py-1.5 text-right font-medium">Quantity</th>
          </tr>
        </thead>
        <tbody>
          {#each transfer.items as i (i.id)}
            <tr class="border-b last:border-0">
              <td class="py-1.5">{variantLabel(i.variantId)}</td>
              <td class="py-1.5 text-right">{i.qty}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
  {/if}
</div>
