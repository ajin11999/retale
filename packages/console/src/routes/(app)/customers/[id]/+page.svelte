<script lang="ts">
  import { CachePolicy, graphql } from "$houdini";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { Trash2 } from "@lucide/svelte";
  import type { Viewer } from "../../+layout.server";
  import { formatMoney } from "$lib/utils";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import IconButton from "$lib/components/ui/icon-button.svelte";
  import Combobox from "$lib/components/ui/combobox.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import MoneyInput from "$lib/components/ui/money-input.svelte";
  import Pagination from "$lib/components/ui/pagination.svelte";
  import Textarea from "$lib/components/ui/textarea.svelte";
  import { t } from "$lib/i18n";
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

  // Recent orders need report.sales.view — a separate query, fetched
  // imperatively only for viewers who hold that key (else it would error the
  // combined document for everyone else). Uses the nested Customer.orders
  // field rather than the top-level orders filter.
  const CustomerOrders = graphql(`
    query ConsoleCustomerOrders($customerId: ID!) {
      customer(id: $customerId) {
        id
        orders(limit: 50) {
          id
          displayNumber
          status
          totalMinor
          closedAt
          cancelledAt
          createdAt
        }
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

  const CreateCustomerSale = graphql(`
    mutation ConsoleCreateCustomerSale($customerId: ID!, $note: String) {
      createCustomerSale(customerId: $customerId, note: $note) {
        id
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const CustomerDetail = $derived(data.CustomerDetail);
  const customer = $derived($CustomerDetail.data?.customer);
  const prices = $derived($CustomerDetail.data?.customerPrices ?? []);
  const products = $derived($CustomerDetail.data?.products ?? []);

  // Flat variant options for the price-override picker ({ value, label } so
  // they feed the searchable Combobox directly).
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
  const variantLabel = (id: string) =>
    variantOptions.find((v) => v.value === id)?.label ?? t("products.unknown");

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
  const canViewOrders = $derived(has("report.sales.view"));
  const canCreateSale = $derived(has("order.create_customer_sale"));

  let saleNote = $state("");

  async function startSale() {
    if (!customer) return;
    busy = true;
    feedback = null;
    try {
      const res = await CreateCustomerSale.mutate({
        customerId: customer.id,
        note: saleNote.trim() || null,
      });
      if (res.errors?.length) {
        feedback = { ok: false, text: res.errors[0].message };
        return;
      }
      const id = res.data?.createCustomerSale.id;
      if (id) await goto(`/orders/${id}`);
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
    } finally {
      busy = false;
    }
  }

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

  // Load recent orders once, for viewers allowed to see them.
  let ordersLoaded = $state(false);
  $effect(() => {
    if (customer && canViewOrders && !ordersLoaded) {
      ordersLoaded = true;
      CustomerOrders.fetch({ variables: { customerId: customer.id } });
    }
  });
  const custOrders = $derived($CustomerOrders.data?.customer?.orders ?? []);

  // Each ledger row's running AR balance immediately after that entry. The
  // ledger comes newest-first, so we anchor at the customer's current balance
  // (the balance after the newest entry) and walk backwards, subtracting each
  // newer entry's delta. Anchoring at the live balance keeps this correct even
  // when the ledger is truncated to its 100-row limit.
  const ledgerRows = $derived.by(() => {
    let balance = customer?.balanceMinor ?? 0;
    return ledger.map((e) => {
      const balanceAfter = balance;
      balance -= e.amountMinor;
      return { ...e, balanceAfter };
    });
  });

  let pricesPage = $state(1);
  const pageSize = 50;
  const paginatedPrices = $derived(prices.slice((pricesPage - 1) * pageSize, pricesPage * pageSize));

  let ledgerPage = $state(1);
  const paginatedLedger = $derived(ledgerRows.slice((ledgerPage - 1) * pageSize, ledgerPage * pageSize));

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
      feedback = { ok: true, text: t("common.saved", { label }) };
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
    // NetworkOnly: a payment/adjustment adds a ledger row the cache doesn't
    // know about, so CacheOrNetwork would replay the stale ledger and balance.
    await CustomerDetail.fetch({
      variables: { id: customer.id },
      policy: CachePolicy.NetworkOnly,
    });
    if (canViewLedger) {
      await CustomerLedger.fetch({
        variables: { customerId: customer.id },
        policy: CachePolicy.NetworkOnly,
      });
    }
    if (canViewOrders) {
      await CustomerOrders.fetch({
        variables: { customerId: customer.id },
        policy: CachePolicy.NetworkOnly,
      });
    }
  };

  async function saveCustomer() {
    if (!customer) return;
    await run(t("common.customer"), () =>
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
    const ok = await run(t("common.customer"), () =>
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
    const ok = await run(t("customers.creditLimit"), () =>
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
      !confirm(t("customerDetail.confirmDelete", { name: customer.name }))
    )
      return;
    const ok = await run(t("common.customer"), () =>
      HardDeleteCustomer.mutate({ id: customer.id }),
    );
    if (ok) await goto("/customers");
  }

  // ---- Payment / adjustment ------------------------------------------------
  let payAmount = $state<number | null>(null);
  let payNote = $state("");

  async function recordPayment() {
    if (!customer || !payAmount || payAmount <= 0) return;
    const ok = await run(t("customerDetail.labelPayment"), () =>
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
    const ok = await run(t("customerDetail.labelAdjustment"), () =>
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
  let priceDraft = $state<{ variantId: string; priceMinor: number | null } | null>(
    null,
  );

  async function savePrice() {
    const d = priceDraft;
    if (!customer || !d || !d.variantId) return;
    const ok = await run(t("customerDetail.labelPriceOverride"), () =>
      SetCustomerPrice.mutate({
        customerId: customer.id,
        variantId: d.variantId,
        priceMinor: d.priceMinor ?? 0,
      }),
    );
    if (ok) {
      priceDraft = null;
      await refetch();
    }
  }

  async function removePrice(variantId: string) {
    if (!customer || !confirm(t("customerDetail.confirmRemovePrice"))) return;
    const ok = await run(t("customerDetail.labelPriceOverride"), () =>
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
  <title>{t("customerDetail.pageTitle", { name: customer ? customer.name : t("common.customer") })}</title>
</svelte:head>

<div class="mx-auto max-w-3xl space-y-6">
  <a
    href="/customers"
    class="text-sm text-muted-foreground hover:text-foreground"
    >{t("customerDetail.backToCustomers")}</a
  >

  {#if $CustomerDetail.fetching && !customer}
    <p class="text-sm text-muted-foreground">{t("common.loading")}</p>
  {:else if !customer}
    <p class="text-sm text-destructive">{t("customerDetail.notFound")}</p>
  {:else}
    <div class="flex items-start justify-between gap-4">
      <div>
        <h1 class="text-xl font-semibold">{customer.name}</h1>
        <p class="text-sm text-muted-foreground">
          {t("customers.arBalance")}
          <span
            class="font-medium {overLimit
              ? 'text-destructive'
              : 'text-foreground'}"
          >
            {formatMoney(customer.balanceMinor)}
          </span>
          {#if overLimit}
            <Badge class="ml-1 bg-destructive/10 text-destructive">
              {t("customerDetail.overCreditLimit")}
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
          {customer.archivedAt ? t("common.archived") : t("common.active")}
        </Badge>
        {#if !customer.archivedAt && canCreateSale}
          <Input
            bind:value={saleNote}
            placeholder={t("customerDetail.saleNote")}
            class="w-52"
            disabled={busy}
          />
          <Button size="sm" disabled={busy} onclick={startSale}>
            {t("orders.newSale")}
          </Button>
        {/if}
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !canArchive}
          onclick={toggleArchived}
        >
          {customer.archivedAt ? t("products.restore") : t("products.archive")}
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
        {t("customerDetail.readOnlyNotice")}
      </p>
    {/if}

    <!-- Details -->
    <section class="space-y-4 rounded-lg border bg-card p-5">
      <h2 class="text-sm font-semibold">{t("products.details")}</h2>
      <div class="grid grid-cols-2 gap-4">
        <label class="space-y-1">
          <span class="text-sm font-medium">{t("common.name")}</span>
          <Input bind:value={form.name} disabled={!canEdit} />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">{t("customers.phone")}</span>
          <Input bind:value={form.phone} disabled={!canEdit} />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">{t("customers.email")}</span>
          <Input bind:value={form.email} disabled={!canEdit} />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">{t("customerDetail.address")}</span>
          <Input bind:value={form.address} disabled={!canEdit} />
        </label>
      </div>
      <label class="space-y-1">
        <span class="text-sm font-medium">{t("common.notes")}</span>
        <Textarea
          bind:value={form.notes}
          disabled={!canEdit}
          class="h-20 resize-none"
        />
      </label>
      <div class="flex justify-end pt-2">
        <Button disabled={busy || !canEdit} onclick={saveCustomer}>
          {t("products.saveDetails")}
        </Button>
      </div>
    </section>

    <!-- Credit limit -->
    {#if canSetCreditLimit}
      <section class="space-y-2 rounded-lg border bg-card p-5">
        <h2 class="text-sm font-semibold">{t("customers.creditLimit")}</h2>
        <div class="flex items-end gap-2">
          <label class="space-y-1">
            <span class="text-xs font-medium">{t("customerDetail.limitRp")}</span>
            <MoneyInput
              bind:value={creditLimit}
              placeholder={t("customerDetail.emptyNoLimit")}
              class="w-48"
            />
          </label>
          <Button size="sm" disabled={busy} onclick={saveCreditLimit}>
            {t("customerDetail.saveLimit")}
          </Button>
        </div>
        <p class="text-xs text-muted-foreground">
          {t("customerDetail.clearLimitHint")}
        </p>
      </section>
    {/if}

    <!-- Accounts receivable -->
    <section class="space-y-4 rounded-lg border bg-card p-5">
      <h2 class="text-sm font-semibold">{t("customerDetail.accountsReceivable")}</h2>

      {#if canRecordPayment}
        <div class="space-y-2">
          <h3 class="text-xs font-medium text-muted-foreground">
            {t("customerDetail.recordDebtPayment")}
          </h3>
          <div class="flex items-end gap-2">
            <label class="space-y-1">
              <span class="text-xs font-medium">{t("customerDetail.amountRp")}</span>
              <MoneyInput bind:value={payAmount} class="w-40" />
            </label>
            <label class="flex-1 space-y-1">
              <span class="text-xs font-medium">{t("customerDetail.noteOptional")}</span>
              <Input bind:value={payNote} />
            </label>
            <Button
              size="sm"
              disabled={busy || !payAmount || payAmount <= 0}
              onclick={recordPayment}>{t("customerDetail.recordPayment")}</Button
            >
          </div>
        </div>
      {/if}

      {#if canAdjust}
        <div class="space-y-2">
          <h3 class="text-xs font-medium text-muted-foreground">
            {t("customerDetail.manualAdjustment")}
          </h3>
          <div class="flex items-end gap-2">
            <label class="space-y-1">
              <span class="text-xs font-medium">{t("customerDetail.signedAmountRp")}</span>
              <MoneyInput allowNegative bind:value={adjAmount} class="w-40" />
            </label>
            <label class="flex-1 space-y-1">
              <span class="text-xs font-medium">{t("customerDetail.noteRequired")}</span>
              <Input bind:value={adjNote} />
            </label>
            <Button
              size="sm"
              disabled={busy || !adjAmount || !adjNote.trim()}
              onclick={adjustBalance}>{t("customerDetail.adjust")}</Button
            >
          </div>
          <p class="text-xs text-muted-foreground">
            {t("customerDetail.adjustHelp")}
          </p>
        </div>
      {/if}

      {#if !canRecordPayment && !canAdjust}
        <p class="text-sm text-muted-foreground">
          {t("customerDetail.noPaymentPermission")}
        </p>
      {/if}
    </section>

    <!-- Price overrides -->
    <section class="space-y-3 rounded-lg border bg-card p-5">
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold">
          {t("customerDetail.priceOverrides", { count: prices.length })}
        </h2>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !canEdit}
          onclick={() => (priceDraft = { variantId: "", priceMinor: 0 })}
        >
          {t("customerDetail.addOverride")}
        </Button>
      </div>

      <table class="w-full text-sm">
        <thead class="border-b text-left text-muted-foreground">
          <tr>
            <th class="py-1.5 font-medium">{t("products.variant")}</th>
            <th class="py-1.5 text-right font-medium">{t("customerDetail.overridePrice")}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each paginatedPrices as p (p.id)}
            <tr class="border-b last:border-0">
              <td class="py-1.5">{variantLabel(p.variantId)}</td>
              <td class="py-1.5 text-right">{formatMoney(p.priceMinor)}</td>
              <td class="py-1.5 text-right">
                <IconButton
                  icon={Trash2}
                  label={t("customerDetail.removePrice")}
                  variant="destructive"
                  disabled={busy || !canEdit}
                  onclick={() => removePrice(p.variantId)}
                />
              </td>
            </tr>
          {/each}
          {#if prices.length === 0}
            <tr>
              <td colspan="3" class="py-6 text-center text-muted-foreground">
                {t("customerDetail.noOverrides")}
              </td>
            </tr>
          {/if}
        </tbody>
      </table>
      <div class="mt-2 flex justify-end">
        <Pagination bind:page={pricesPage} {pageSize} totalItems={prices.length} />
      </div>

      {#if priceDraft}
        <div class="space-y-3 rounded-md border bg-background p-4">
          <h3 class="text-sm font-semibold">{t("customerDetail.newOverride")}</h3>
          <div class="grid grid-cols-2 gap-3">
            <label class="space-y-1">
              <span class="text-xs font-medium">{t("products.variant")}</span>
              <Combobox
                options={variantOptions}
                bind:value={priceDraft.variantId}
                placeholder={t("customerDetail.searchVariant")}
                disabled={!canEdit}
              />
            </label>
            <label class="space-y-1">
              <span class="text-xs font-medium">{t("products.priceRp")}</span>
              <MoneyInput bind:value={priceDraft.priceMinor} disabled={!canEdit} />
            </label>
          </div>
          <div class="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onclick={() => (priceDraft = null)}>{t("common.cancel")}</Button
            >
            <Button
              size="sm"
              disabled={busy || !canEdit || !priceDraft.variantId}
              onclick={savePrice}>{t("customerDetail.saveOverride")}</Button
            >
          </div>
        </div>
      {/if}
    </section>

    <!-- Ledger -->
    {#if canViewLedger}
      <section class="space-y-3 rounded-lg border bg-card p-5">
        <h2 class="text-sm font-semibold">{t("customerDetail.arLedger", { count: ledger.length })}</h2>
        {#if $CustomerLedger.fetching && ledger.length === 0}
          <p class="text-sm text-muted-foreground">{t("common.loading")}</p>
        {:else}
          <table class="w-full text-sm">
            <thead class="border-b text-left text-muted-foreground">
              <tr>
                <th class="py-1.5 pr-4 font-medium">{t("orders.when")}</th>
                <th class="py-1.5 pr-4 font-medium">{t("common.type")}</th>
                <th class="py-1.5 pl-4 text-right font-medium">{t("common.amount")}</th>
                <th class="py-1.5 pl-4 text-right font-medium">{t("common.balance")}</th>
                <th class="py-1.5 pl-6 font-medium">{t("common.note")}</th>
              </tr>
            </thead>
            <tbody>
              {#each paginatedLedger as e (e.id)}
                <tr class="border-b last:border-0">
                  <td class="whitespace-nowrap py-1.5 pr-4">
                    {fmtDateTime(e.createdAt)}
                  </td>
                  <td class="py-1.5 pr-4">{t(`ledgerType.${e.type}`)}</td>
                  <td
                    class="whitespace-nowrap py-1.5 pl-4 text-right tabular-nums {e.amountMinor <
                    0
                      ? 'text-emerald-700'
                      : ''}"
                  >
                    {formatMoney(e.amountMinor)}
                  </td>
                  <td
                    class="whitespace-nowrap py-1.5 pl-4 text-right tabular-nums font-medium"
                  >
                    {formatMoney(e.balanceAfter)}
                  </td>
                  <td class="py-1.5 pl-6 text-muted-foreground">
                    {e.note ?? "—"}
                  </td>
                </tr>
              {/each}
              {#if ledgerRows.length === 0}
                <tr>
                  <td colspan="5" class="py-6 text-center text-muted-foreground">
                    {t("customerDetail.noLedgerEntries")}
                  </td>
                </tr>
              {/if}
            </tbody>
          </table>
          <div class="mt-2 flex justify-end">
            <Pagination bind:page={ledgerPage} {pageSize} totalItems={ledgerRows.length} />
          </div>
        {/if}
      </section>
    {/if}

    <!-- Orders -->
    {#if canViewOrders}
      <section class="space-y-3 rounded-lg border bg-card p-5">
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-semibold">
            {t("customerDetail.orders", { count: custOrders.length })}
          </h2>
          <a
            href={`/orders?customer=${customer.id}`}
            class="text-xs text-primary hover:underline"
          >
            {t("customerDetail.viewAllOrders")}
          </a>
        </div>
        {#if $CustomerOrders.fetching && custOrders.length === 0}
          <p class="text-sm text-muted-foreground">{t("common.loading")}</p>
        {:else}
          <table class="w-full text-sm">
            <thead class="border-b text-left text-muted-foreground">
              <tr>
                <th class="py-1.5 font-medium">{t("orders.number")}</th>
                <th class="py-1.5 pr-4 font-medium">{t("orders.when")}</th>
                <th class="py-1.5 pl-4 text-right font-medium">{t("common.total")}</th>
                <th class="py-1.5 pl-4 font-medium">{t("common.status")}</th>
              </tr>
            </thead>
            <tbody>
              {#each custOrders as o (o.id)}
                <tr class="border-b last:border-0">
                  <td class="py-1.5">
                    <a
                      href={`/orders/${o.id}`}
                      class="font-mono text-xs text-primary hover:underline"
                    >
                      {o.displayNumber ?? o.id.slice(-8)}
                    </a>
                  </td>
                  <td class="whitespace-nowrap py-1.5 pr-4">
                    {fmtDateTime(o.closedAt ?? o.cancelledAt ?? o.createdAt)}
                  </td>
                  <td
                    class="whitespace-nowrap py-1.5 pl-4 text-right tabular-nums"
                  >
                    {formatMoney(o.totalMinor)}
                  </td>
                  <td class="py-1.5 pl-4">{t(`orders.status.${o.status}`)}</td>
                </tr>
              {/each}
              {#if custOrders.length === 0}
                <tr>
                  <td colspan="4" class="py-6 text-center text-muted-foreground">
                    {t("customerDetail.noOrders")}
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
        <h2 class="text-sm font-semibold text-destructive">{t("customerDetail.dangerZone")}</h2>
        <p class="text-sm text-muted-foreground">
          {t("customerDetail.dangerZoneHelp")}
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || customer.balanceMinor !== 0}
          onclick={hardDelete}
        >
          {t("customerDetail.deleteCustomer")}
        </Button>
        {#if customer.balanceMinor !== 0}
          <p class="text-xs text-muted-foreground">
            {t("customerDetail.clearBalanceFirst")}
          </p>
        {/if}
      </section>
    {/if}
  {/if}
</div>
