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
  // customerPrices reuses customer.edit, so it travels in the main query.
  graphql(`
    query CustomerDetail($id: ID!) {
      customer(id: $id) {
        id
        name
        phone
        email
        address
        notes
        balanceMinor
        creditLimitMinor
        archivedAt
      }
      customerPrices(customerId: $id) {
        id
        variantId
        priceMinor
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

  // The AR ledger needs report.ar_aging.view — a separate query, fetched
  // imperatively only for viewers who hold that key (else it would error the
  // combined document for everyone else).
  const CustomerLedger = graphql(`
    query ConsoleCustomerLedger($customerId: ID!) {
      customerLedger(customerId: $customerId, limit: 100) {
        id
        type
        amountMinor
        refType
        note
        createdAt
      }
    }
  `);

  const UpdateCustomer = graphql(`
    mutation ConsoleUpdateCustomer(
      $id: ID!
      $name: String
      $phone: String
      $email: String
      $address: String
      $notes: String
    ) {
      updateCustomer(
        id: $id
        name: $name
        phone: $phone
        email: $email
        address: $address
        notes: $notes
      ) {
        id
        name
        phone
        email
        address
        notes
      }
    }
  `);

  const SetCustomerArchived = graphql(`
    mutation ConsoleSetCustomerArchived($id: ID!, $archived: Boolean!) {
      setCustomerArchived(id: $id, archived: $archived) {
        id
        archivedAt
      }
    }
  `);

  const SetCreditLimit = graphql(`
    mutation ConsoleSetCustomerCreditLimit($id: ID!, $creditLimitMinor: Float) {
      setCustomerCreditLimit(id: $id, creditLimitMinor: $creditLimitMinor) {
        id
        creditLimitMinor
      }
    }
  `);

  const HardDeleteCustomer = graphql(`
    mutation ConsoleHardDeleteCustomer($id: ID!) {
      hardDeleteCustomer(id: $id)
    }
  `);

  const RecordDebtPayment = graphql(`
    mutation ConsoleRecordDebtPayment(
      $customerId: ID!
      $amountMinor: Float!
      $note: String
    ) {
      recordDebtPayment(
        customerId: $customerId
        amountMinor: $amountMinor
        note: $note
      ) {
        id
        balanceMinor
      }
    }
  `);

  const AdjustCustomerBalance = graphql(`
    mutation ConsoleAdjustCustomerBalance(
      $customerId: ID!
      $amountMinor: Float!
      $note: String!
    ) {
      adjustCustomerBalance(
        customerId: $customerId
        amountMinor: $amountMinor
        note: $note
      ) {
        id
        balanceMinor
      }
    }
  `);

  const SetCustomerPrice = graphql(`
    mutation ConsoleSetCustomerPrice(
      $customerId: ID!
      $variantId: ID!
      $priceMinor: Float!
    ) {
      setCustomerPrice(
        customerId: $customerId
        variantId: $variantId
        priceMinor: $priceMinor
      ) {
        id
      }
    }
  `);

  const RemoveCustomerPrice = graphql(`
    mutation ConsoleRemoveCustomerPrice($customerId: ID!, $variantId: ID!) {
      removeCustomerPrice(customerId: $customerId, variantId: $variantId)
    }
  `);

  let { data }: { data: PageData } = $props();
  const CustomerDetail = $derived(data.CustomerDetail);
  const customer = $derived($CustomerDetail.data?.customer);
  const prices = $derived($CustomerDetail.data?.customerPrices ?? []);
  const products = $derived($CustomerDetail.data?.products ?? []);

  // Flat variant options for the price-override picker.
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
  const variantLabel = (id: string) =>
    variantOptions.find((v) => v.id === id)?.label ?? "Unknown variant";

  // ---- Viewer permissions --------------------------------------------------
  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canEdit = $derived(has("customer.edit"));
  const canArchive = $derived(has("customer.archive"));
  const canSetCreditLimit = $derived(has("customer.set_credit_limit"));
  const canRecordPayment = $derived(has("debt.record_payment"));
  const canAdjust = $derived(has("customer.adjustment"));
  const canHardDelete = $derived(has("customer.hard_delete"));
  const canViewLedger = $derived(has("report.ar_aging.view"));

  // ---- Header form ---------------------------------------------------------
  interface CustomerForm {
    name: string;
    phone: string;
    email: string;
    address: string;
    notes: string;
  }
  let form = $state<CustomerForm>({
    name: "",
    phone: "",
    email: "",
    address: "",
    notes: "",
  });

  // Reset the form when a different customer loads — not on a plain refetch,
  // so in-progress edits survive.
  let syncedId = $state("");
  $effect(() => {
    const c = customer;
    if (c && c.id !== syncedId) {
      syncedId = c.id;
      form = {
        name: c.name,
        phone: c.phone ?? "",
        email: c.email ?? "",
        address: c.address ?? "",
        notes: c.notes ?? "",
      };
      creditLimit = c.creditLimitMinor ?? null;
    }
  });

  // ---- Credit limit --------------------------------------------------------
  let creditLimit = $state<number | null>(null);

  // Load the ledger once, for viewers allowed to see it.
  let ledgerLoaded = $state(false);
  $effect(() => {
    if (customer && canViewLedger && !ledgerLoaded) {
      ledgerLoaded = true;
      CustomerLedger.fetch({ variables: { customerId: customer.id } });
    }
  });
  const ledger = $derived($CustomerLedger.data?.customerLedger ?? []);

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
    if (!customer) return;
    await CustomerDetail.fetch({ variables: { id: customer.id } });
    if (canViewLedger) {
      await CustomerLedger.fetch({ variables: { customerId: customer.id } });
    }
  };

  async function saveCustomer() {
    if (!customer) return;
    await run("Customer", () =>
      UpdateCustomer.mutate({
        id: customer.id,
        name: form.name.trim(),
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        address: form.address.trim() || null,
        notes: form.notes.trim() || null,
      }),
    );
  }

  async function toggleArchived() {
    if (!customer) return;
    const ok = await run("Customer", () =>
      SetCustomerArchived.mutate({
        id: customer.id,
        archived: customer.archivedAt == null,
      }),
    );
    if (ok) await refetch();
  }

  async function saveCreditLimit() {
    if (!customer) return;
    // An empty input clears the limit (null).
    const ok = await run("Credit limit", () =>
      SetCreditLimit.mutate({
        id: customer.id,
        creditLimitMinor: creditLimit == null ? null : creditLimit,
      }),
    );
    if (ok) await refetch();
  }

  async function hardDelete() {
    if (!customer) return;
    if (
      !confirm(`Permanently delete "${customer.name}"? This cannot be undone.`)
    )
      return;
    const ok = await run("Customer", () =>
      HardDeleteCustomer.mutate({ id: customer.id }),
    );
    if (ok) await goto("/customers");
  }

  // ---- Payment / adjustment ------------------------------------------------
  let payAmount = $state<number | null>(null);
  let payNote = $state("");

  async function recordPayment() {
    if (!customer || !payAmount || payAmount <= 0) return;
    const ok = await run("Payment", () =>
      RecordDebtPayment.mutate({
        customerId: customer.id,
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
    if (!customer || !adjAmount || !adjNote.trim()) return;
    const ok = await run("Adjustment", () =>
      AdjustCustomerBalance.mutate({
        customerId: customer.id,
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

  // ---- Price overrides -----------------------------------------------------
  let priceDraft = $state<{ variantId: string; priceMinor: number } | null>(
    null,
  );

  async function savePrice() {
    const d = priceDraft;
    if (!customer || !d || !d.variantId) return;
    const ok = await run("Price override", () =>
      SetCustomerPrice.mutate({
        customerId: customer.id,
        variantId: d.variantId,
        priceMinor: d.priceMinor,
      }),
    );
    if (ok) {
      priceDraft = null;
      await refetch();
    }
  }

  async function removePrice(variantId: string) {
    if (!customer || !confirm("Remove this price override?")) return;
    const ok = await run("Price override", () =>
      RemoveCustomerPrice.mutate({ customerId: customer.id, variantId }),
    );
    if (ok) await refetch();
  }

  const fmtDateTime = (iso: string) => new Date(iso).toLocaleString("id-ID");
  const overLimit = $derived(
    !!customer &&
      customer.creditLimitMinor != null &&
      customer.balanceMinor > customer.creditLimitMinor,
  );
</script>

<svelte:head>
  <title>{customer ? customer.name : "Customer"} · Retale Console</title>
</svelte:head>

<div class="mx-auto max-w-3xl space-y-6">
  <a
    href="/customers"
    class="text-sm text-muted-foreground hover:text-foreground"
    >← Back to customers</a
  >

  {#if $CustomerDetail.fetching && !customer}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if !customer}
    <p class="text-sm text-destructive">Customer not found.</p>
  {:else}
    <div class="flex items-start justify-between gap-4">
      <div>
        <h1 class="text-xl font-semibold">{customer.name}</h1>
        <p class="text-sm text-muted-foreground">
          AR balance
          <span
            class="font-medium {overLimit
              ? 'text-destructive'
              : 'text-foreground'}"
          >
            {formatMoney(customer.balanceMinor)}
          </span>
          {#if overLimit}
            <Badge class="ml-1 bg-destructive/10 text-destructive">
              over credit limit
            </Badge>
          {/if}
        </p>
      </div>
      <div class="flex items-center gap-3">
        <Badge
          class={customer.archivedAt
            ? "bg-muted text-muted-foreground"
            : "bg-emerald-100 text-emerald-700"}
        >
          {customer.archivedAt ? "Archived" : "Active"}
        </Badge>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !canArchive}
          onclick={toggleArchived}
        >
          {customer.archivedAt ? "Restore" : "Archive"}
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
        You have read-only access to customers — editing is disabled.
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
          <span class="text-sm font-medium">Address</span>
          <Input bind:value={form.address} disabled={!canEdit} />
        </label>
      </div>
      <label class="space-y-1">
        <span class="text-sm font-medium">Notes</span>
        <Textarea
          bind:value={form.notes}
          disabled={!canEdit}
          class="h-20 resize-none"
        />
      </label>
      <div class="flex justify-end">
        <Button disabled={busy || !canEdit} onclick={saveCustomer}>
          Save details
        </Button>
      </div>
    </section>

    <!-- Credit limit -->
    {#if canSetCreditLimit}
      <section class="space-y-2 rounded-lg border bg-card p-5">
        <h2 class="text-sm font-semibold">Credit limit</h2>
        <div class="flex items-end gap-2">
          <label class="space-y-1">
            <span class="text-xs font-medium">Limit (minor units)</span>
            <Input
              type="number"
              bind:value={creditLimit}
              placeholder="Empty = no limit"
              class="w-48"
            />
          </label>
          <Button size="sm" disabled={busy} onclick={saveCreditLimit}>
            Save limit
          </Button>
        </div>
        <p class="text-xs text-muted-foreground">
          Leave empty and save to clear the limit.
        </p>
      </section>
    {/if}

    <!-- Accounts receivable -->
    <section class="space-y-4 rounded-lg border bg-card p-5">
      <h2 class="text-sm font-semibold">Accounts receivable</h2>

      {#if canRecordPayment}
        <div class="space-y-2">
          <h3 class="text-xs font-medium text-muted-foreground">
            Record a debt payment
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
            Positive raises what they owe; negative lowers it.
          </p>
        </div>
      {/if}

      {#if !canRecordPayment && !canAdjust}
        <p class="text-sm text-muted-foreground">
          You don't have permission to record payments or adjustments.
        </p>
      {/if}
    </section>

    <!-- Price overrides -->
    <section class="space-y-3 rounded-lg border bg-card p-5">
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold">
          Price overrides ({prices.length})
        </h2>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !canEdit}
          onclick={() => (priceDraft = { variantId: "", priceMinor: 0 })}
        >
          Add override
        </Button>
      </div>

      <table class="w-full text-sm">
        <thead class="border-b text-left text-muted-foreground">
          <tr>
            <th class="py-1.5 font-medium">Variant</th>
            <th class="py-1.5 text-right font-medium">Override price</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each prices as p (p.id)}
            <tr class="border-b last:border-0">
              <td class="py-1.5">{variantLabel(p.variantId)}</td>
              <td class="py-1.5 text-right">{formatMoney(p.priceMinor)}</td>
              <td class="py-1.5 text-right">
                <button
                  class="text-xs text-destructive hover:underline disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={busy || !canEdit}
                  onclick={() => removePrice(p.variantId)}>Remove</button
                >
              </td>
            </tr>
          {/each}
          {#if prices.length === 0}
            <tr>
              <td colspan="3" class="py-6 text-center text-muted-foreground">
                No price overrides — this customer pays list price.
              </td>
            </tr>
          {/if}
        </tbody>
      </table>

      {#if priceDraft}
        <div class="space-y-3 rounded-md border bg-background p-4">
          <h3 class="text-sm font-semibold">New price override</h3>
          <div class="grid grid-cols-2 gap-3">
            <label class="space-y-1">
              <span class="text-xs font-medium">Variant</span>
              <Select bind:value={priceDraft.variantId} disabled={!canEdit}>
                <option value="">— Pick a variant —</option>
                {#each variantOptions as v (v.id)}
                  <option value={v.id}>{v.label}</option>
                {/each}
              </Select>
            </label>
            <label class="space-y-1">
              <span class="text-xs font-medium">Price (minor units)</span>
              <Input
                type="number"
                bind:value={priceDraft.priceMinor}
                disabled={!canEdit}
              />
            </label>
          </div>
          <div class="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onclick={() => (priceDraft = null)}>Cancel</Button
            >
            <Button
              size="sm"
              disabled={busy || !canEdit || !priceDraft.variantId}
              onclick={savePrice}>Save override</Button
            >
          </div>
        </div>
      {/if}
    </section>

    <!-- Ledger -->
    {#if canViewLedger}
      <section class="space-y-3 rounded-lg border bg-card p-5">
        <h2 class="text-sm font-semibold">AR ledger ({ledger.length})</h2>
        {#if $CustomerLedger.fetching && ledger.length === 0}
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
          Permanently delete this customer. Refused by the API if it carries a
          non-zero AR balance.
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || customer.balanceMinor !== 0}
          onclick={hardDelete}
        >
          Delete customer
        </Button>
        {#if customer.balanceMinor !== 0}
          <p class="text-xs text-muted-foreground">
            Clear the AR balance first.
          </p>
        {/if}
      </section>
    {/if}
  {/if}
</div>
