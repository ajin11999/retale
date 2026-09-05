<script lang="ts">
  import { CachePolicy, graphql } from "$houdini";
  import { page } from "$app/state";
  import { Trash2 } from "@lucide/svelte";
  import type { Viewer } from "../../+layout.server";
  import { formatMoney, matchesTokens, searchTokens } from "$lib/utils";
  import { t } from "$lib/i18n";
  import { refetchOnVisible } from "$lib/refetch-on-visible.svelte";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import IconButton from "$lib/components/ui/icon-button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import MoneyInput from "$lib/components/ui/money-input.svelte";
  import Pagination from "$lib/components/ui/pagination.svelte";
  import Select from "$lib/components/ui/select.svelte";
  import Textarea from "$lib/components/ui/textarea.svelte";
  import type { PageData } from "./$types";

  graphql(`
    query TrackingAccountDetail($id: ID!) {
      trackingAccount(id: $id) {
        id
        parentId
        name
        code
        accountCategory
        counterCategory
        notes
        balanceMinor
        archivedAt
        createdAt
        updatedAt
        linkedVariants {
          variantId
          productId
          productName
          sku
          label
        }
      }
      assignableTrackingVariants {
        variantId
        productId
        productName
        sku
        label
        currentTrackingAccountId
        currentTrackingAccountName
      }
      trackingAccountLedger(accountId: $id, limit: 500) {
        id
        type
        amountMinor
        refType
        refId
        counterCategoryOverride
        note
        posSessionId
        createdAt
      }
    }
  `);

  const UpdateAccount = graphql(`
    mutation ConsoleUpdateTrackingAccount(
      $id: ID!
      $name: String
      $code: String
      $accountCategory: String
      $counterCategory: String
      $notes: String
    ) {
      updateTrackingAccount(
        id: $id
        name: $name
        code: $code
        accountCategory: $accountCategory
        counterCategory: $counterCategory
        notes: $notes
      ) {
        id
        updatedAt
      }
    }
  `);

  const SetArchived = graphql(`
    mutation ConsoleSetTrackingAccountArchived($id: ID!, $archived: Boolean!) {
      setTrackingAccountArchived(id: $id, archived: $archived) {
        id
        archivedAt
      }
    }
  `);

  const RecordPayout = graphql(`
    mutation ConsoleRecordTrackingPayout(
      $accountId: ID!
      $amountMinor: Float!
      $note: String
    ) {
      recordTrackingPayout(
        accountId: $accountId
        amountMinor: $amountMinor
        note: $note
      ) {
        id
        balanceMinor
      }
    }
  `);

  const RecordDeposit = graphql(`
    mutation ConsoleRecordTrackingDeposit(
      $accountId: ID!
      $amountMinor: Float!
      $note: String
    ) {
      recordTrackingDeposit(
        accountId: $accountId
        amountMinor: $amountMinor
        note: $note
      ) {
        id
        balanceMinor
      }
    }
  `);

  const SetVariants = graphql(`
    mutation ConsoleSetTrackingAccountVariants(
      $accountId: ID!
      $variantIds: [ID!]!
    ) {
      setTrackingAccountVariants(accountId: $accountId, variantIds: $variantIds) {
        variantId
        productId
        productName
        sku
        label
      }
    }
  `);

  const AdjustBalance = graphql(`
    mutation ConsoleAdjustTrackingBalance(
      $accountId: ID!
      $amountMinor: Float!
      $note: String!
    ) {
      adjustTrackingBalance(
        accountId: $accountId
        amountMinor: $amountMinor
        note: $note
      ) {
        id
        balanceMinor
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const Detail = $derived(data.TrackingAccountDetail);

  // Variants created in another tab won't appear in the assignment picker —
  // Houdini serves the cached query. Re-pull when the tab becomes visible.
  refetchOnVisible(() => Detail.fetch({ policy: CachePolicy.NetworkOnly }));

  const account = $derived($Detail.data?.trackingAccount ?? null);
  const ledger = $derived($Detail.data?.trackingAccountLedger ?? []);
  const assignable = $derived(
    $Detail.data?.assignableTrackingVariants ?? [],
  );
  const linkedVariants = $derived(account?.linkedVariants ?? []);

  // Each ledger row's running balance immediately after that entry. The
  // ledger comes newest-first, so we anchor at the account's live balanceMinor
  // and walk backwards, subtracting each newer entry's amountMinor.
  const ledgerWithBalance = $derived.by(() => {
    let balance = account?.balanceMinor ?? 0;
    return ledger.map((e) => {
      const balanceAfter = balance;
      balance -= e.amountMinor;
      return { ...e, balanceAfter };
    });
  });

  let ledgerSearch = $state("");
  let ledgerTypeFilter = $state<"all" | "attribution" | "payout" | "deposit" | "adjustment" | "opening_balance">("all");

  const filteredLedger = $derived.by(() => {
    const tokens = searchTokens(ledgerSearch.trim());
    let list = ledgerWithBalance;
    if (ledgerTypeFilter !== "all") {
      list = list.filter((e) => e.type === ledgerTypeFilter);
    }
    if (tokens.length > 0) {
      list = list.filter((e) =>
        matchesTokens(
          tokens,
          e.type,
          e.refType,
          e.refId,
          e.note,
          e.counterCategoryOverride,
        ),
      );
    }
    return list;
  });

  let ledgerPage = $state(1);
  let variantsPage = $state(1);
  const pageSize = 50;

  $effect(() => {
    ledgerSearch;
    ledgerTypeFilter;
    ledgerPage = 1;
  });

  const paginatedLedger = $derived(
    filteredLedger.slice((ledgerPage - 1) * pageSize, ledgerPage * pageSize),
  );
  const paginatedLinkedVariants = $derived(
    linkedVariants.slice(
      (variantsPage - 1) * pageSize,
      variantsPage * pageSize,
    ),
  );

  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canEdit = $derived(has("tracking_account.edit"));
  const canArchive = $derived(has("tracking_account.archive"));
  const canPayout = $derived(has("tracking_account.payout"));
  const canDeposit = $derived(has("tracking_account.deposit"));
  const canAdjust = $derived(has("tracking_account.adjustment"));

  // ---- Header editing ------------------------------------------------------
  let editing = $state(false);
  let eName = $state("");
  let eCode = $state("");
  let eAccCat = $state("");
  let eCounterCat = $state("");
  let eNotes = $state("");

  function startEdit() {
    if (!account) return;
    eName = account.name;
    eCode = account.code ?? "";
    eAccCat = account.accountCategory;
    eCounterCat = account.counterCategory;
    eNotes = account.notes ?? "";
    editing = true;
  }

  let busy = $state(false);
  let error = $state<string | null>(null);
  let info = $state<string | null>(null);

  async function saveHeader() {
    if (!account) return;
    busy = true;
    error = null;
    try {
      const res = await UpdateAccount.mutate({
        id: account.id,
        name: eName.trim(),
        code: eCode.trim() || null,
        accountCategory: eAccCat.trim(),
        counterCategory: eCounterCat.trim(),
        notes: eNotes.trim() || null,
      });
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      editing = false;
      await Detail.fetch({ policy: CachePolicy.NetworkOnly });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function toggleArchived() {
    if (!account) return;
    busy = true;
    error = null;
    try {
      const res = await SetArchived.mutate({
        id: account.id,
        archived: !account.archivedAt,
      });
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      await Detail.fetch({ policy: CachePolicy.NetworkOnly });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  // ---- Ledger entry form ---------------------------------------------------
  let action = $state<"payout" | "deposit" | "adjust" | null>(null);
  let aAmount = $state<number | null>(null);
  let aNote = $state<string>("");

  function startAction(kind: "payout" | "deposit" | "adjust") {
    action = kind;
    aAmount = null;
    aNote = "";
  }

  async function submitAction() {
    if (!account || !action) return;
    const amt = aAmount;
    if (amt == null) return;
    busy = true;
    error = null;
    info = null;
    try {
      let res;
      if (action === "payout") {
        res = await RecordPayout.mutate({
          accountId: account.id,
          amountMinor: Math.abs(amt),
          note: aNote.trim() || null,
        });
      } else if (action === "deposit") {
        res = await RecordDeposit.mutate({
          accountId: account.id,
          amountMinor: Math.abs(amt),
          note: aNote.trim() || null,
        });
      } else {
        if (!aNote.trim()) {
          error = t("trackingDetail.adjustNoteRequired");
          return;
        }
        res = await AdjustBalance.mutate({
          accountId: account.id,
          amountMinor: amt,
          note: aNote.trim(),
        });
      }
      if (res?.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      info = t("trackingDetail.recorded");
      action = null;
      await Detail.fetch({ policy: CachePolicy.NetworkOnly });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  const fmtDateTime = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleString("id-ID") : "—";

  // ---- Target variants -----------------------------------------------------
  // Linked variants are edited as a set. We keep a local id list while the
  // user adds/removes; saving issues setTrackingAccountVariants with the union.
  let variantSearch = $state<string>("");
  let pickerOpen = $state(false);
  let highlight = $state(0);

  // Reset the highlight whenever the result set changes (typing, opening).
  $effect(() => {
    void variantSearch;
    highlight = 0;
  });

  function onPickerKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      pickerOpen = true;
      if (pickableMatches.length > 0) {
        highlight = (highlight + 1) % pickableMatches.length;
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (pickableMatches.length > 0) {
        highlight =
          (highlight - 1 + pickableMatches.length) % pickableMatches.length;
      }
    } else if (e.key === "Enter") {
      if (pickableMatches.length === 0) return;
      e.preventDefault();
      const target =
        pickableMatches.length === 1
          ? pickableMatches[0]
          : pickableMatches[highlight] ?? pickableMatches[0];
      addVariantLink(target.variantId);
    } else if (e.key === "Escape") {
      pickerOpen = false;
    }
  }

  async function addVariantLink(variantId: string) {
    if (!account || !variantId) return;
    const next = new Set(linkedVariants.map((v) => v.variantId));
    next.add(variantId);
    await commitVariants([...next]);
    variantSearch = "";
    pickerOpen = false;
  }

  async function removeVariantLink(variantId: string) {
    if (!account) return;
    const reassign = assignable.find(
      (v) =>
        v.variantId === variantId &&
        v.currentTrackingAccountId &&
        v.currentTrackingAccountId !== account.id,
    );
    if (reassign && !confirm(t("trackingDetail.confirmDetach"))) return;
    const next = linkedVariants
      .map((v) => v.variantId)
      .filter((id) => id !== variantId);
    await commitVariants(next);
  }

  async function commitVariants(ids: string[]) {
    if (!account) return;
    busy = true;
    error = null;
    try {
      const res = await SetVariants.mutate({
        accountId: account.id,
        variantIds: ids,
      });
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      await Detail.fetch({ policy: CachePolicy.NetworkOnly });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  // Pickable variants: not already linked here, sorted by product · sku.
  const pickable = $derived.by(() => {
    const linkedSet = new Set(linkedVariants.map((v) => v.variantId));
    return assignable
      .filter((v) => !linkedSet.has(v.variantId))
      .sort((a, b) => {
        const p = a.productName.localeCompare(b.productName);
        return p !== 0 ? p : a.sku.localeCompare(b.sku);
      });
  });

  // AND-match each whitespace-separated token against the row's combined
  // name/SKU/label text, so tokens may match different parts in any order
  // ("nkn 6201" finds "Bearing \ 6201 2RS \ NKN"). Cap the dropdown so a blank
  // query doesn't render thousands of rows.
  const pickableMatches = $derived.by(() => {
    const tokens = variantSearch.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const haystack = tokens.length
      ? pickable.filter((v) => {
          const hay = `${v.productName} ${v.sku} ${v.label ?? ""}`.toLowerCase();
          return tokens.every((t) => hay.includes(t));
        })
      : pickable;
    return haystack.slice(0, 30);
  });
</script>

<svelte:head><title>{t("trackingDetail.pageTitle")}</title></svelte:head>

<div class="space-y-4">
  <a href="/tracking" class="text-sm text-primary hover:underline">
    {t("trackingDetail.backToAccounts")}
  </a>

  {#if error}
    <p class="text-sm text-destructive">{error}</p>
  {/if}
  {#if info}
    <p class="text-sm text-emerald-700">{info}</p>
  {/if}

  {#if $Detail.fetching && !account}
    <p class="text-sm text-muted-foreground">{t("common.loading")}</p>
  {:else if $Detail.errors?.length}
    <p class="text-sm text-destructive">{$Detail.errors[0].message}</p>
  {:else if !account}
    <p class="text-sm text-muted-foreground">{t("trackingDetail.notFound")}</p>
  {:else}
    <!-- Header -->
    <div class="rounded-lg border bg-card p-4">
      <div class="flex items-start justify-between gap-4">
        <div class="flex-1">
          {#if editing}
            <div class="grid grid-cols-2 gap-3">
              <label class="space-y-1">
                <span class="text-sm font-medium">{t("common.name")}</span>
                <Input bind:value={eName} />
              </label>
              <label class="space-y-1">
                <span class="text-sm font-medium">{t("trackingDetail.code")}</span>
                <Input bind:value={eCode} />
              </label>
              <label class="space-y-1">
                <span class="text-sm font-medium">{t("tracking.accountCategory")}</span>
                <Input bind:value={eAccCat} />
              </label>
              <label class="space-y-1">
                <span class="text-sm font-medium">{t("tracking.counterCategory")}</span>
                <Input bind:value={eCounterCat} />
              </label>
              <label class="col-span-2 space-y-1">
                <span class="text-sm font-medium">{t("common.notes")}</span>
                <Textarea bind:value={eNotes} />
              </label>
            </div>
            <div class="mt-3 flex gap-2">
              <Button size="sm" disabled={busy} onclick={saveHeader}>{t("common.save")}</Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onclick={() => (editing = false)}>{t("common.cancel")}</Button
              >
            </div>
          {:else}
            <h1 class="text-xl font-semibold">{account.name}</h1>
            <p class="text-sm text-muted-foreground">
              {#if account.code}{account.code} · {/if}
              <span class="font-mono text-xs">{account.accountCategory}</span>
              → <span class="font-mono text-xs">{account.counterCategory}</span>
            </p>
            {#if account.notes}
              <p class="mt-2 text-sm">{account.notes}</p>
            {/if}
          {/if}
        </div>
        <div class="flex flex-col items-end gap-2">
          <p class="text-xs text-muted-foreground">{t("common.balance")}</p>
          <p class="text-2xl font-semibold">{formatMoney(account.balanceMinor)}</p>
          {#if account.archivedAt}
            <Badge class="bg-muted text-muted-foreground">{t("common.archived")}</Badge>
          {:else}
            <Badge class="bg-emerald-100 text-emerald-700">{t("common.active")}</Badge>
          {/if}
        </div>
      </div>

      <div class="mt-3 flex flex-wrap gap-2 border-t pt-3">
        {#if !editing && canEdit}
          <Button size="sm" variant="outline" onclick={startEdit}>{t("common.edit")}</Button>
        {/if}
        {#if canPayout}
          <Button size="sm" disabled={busy} onclick={() => startAction("payout")}>
            {t("trackingDetail.recordPayout")}
          </Button>
        {/if}
        {#if canDeposit}
          <Button size="sm" disabled={busy} onclick={() => startAction("deposit")}>
            {t("trackingDetail.recordDeposit")}
          </Button>
        {/if}
        {#if canAdjust}
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onclick={() => startAction("adjust")}>{t("tracking.adjustBalance")}</Button
          >
        {/if}
        {#if canArchive}
          <Button
            size="sm"
            variant={account.archivedAt ? "outline" : "destructive"}
            disabled={busy}
            onclick={toggleArchived}
          >
            {account.archivedAt ? t("trackingDetail.restore") : t("trackingDetail.archive")}
          </Button>
        {/if}
      </div>

      {#if action}
        <div class="mt-3 space-y-2 rounded-md border bg-muted/40 p-3">
          <p class="text-sm font-medium capitalize">{action === "payout" ? t("trackingDetail.action.payout") : action === "deposit" ? t("trackingDetail.action.deposit") : t("trackingDetail.action.adjust")}</p>
          {#if action === "adjust"}
            <p class="text-xs text-muted-foreground">
              {t("trackingDetail.adjustHint")}
            </p>
          {:else}
            <p class="text-xs text-muted-foreground">
              {t("trackingDetail.positiveUnits")} {action === "payout"
                ? t("trackingDetail.payoutHint")
                : t("trackingDetail.depositHint")}
            </p>
          {/if}
          <div class="flex items-end gap-2">
            <label class="flex-1 space-y-1">
              <span class="text-xs font-medium">
                {action === "adjust" ? t("trackingDetail.signedAmount") : t("trackingDetail.amountRp")}
              </span>
              <MoneyInput bind:value={aAmount} allowNegative={action === "adjust"} />
            </label>
            <label class="flex-[2] space-y-1">
              <span class="text-xs font-medium">
                {action === "adjust" ? t("trackingDetail.noteRequired") : t("trackingDetail.noteOptional")}
              </span>
              <Input bind:value={aNote} />
            </label>
            <Button size="sm" disabled={busy || aAmount == null} onclick={submitAction}>
              {t("trackingDetail.submit")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onclick={() => (action = null)}>{t("common.cancel")}</Button
            >
          </div>
        </div>
      {/if}
    </div>

    <!-- Target variants -->
    <div class="rounded-lg border bg-card p-4">
      <div class="mb-2 flex items-center justify-between">
        <h2 class="text-sm font-semibold">{t("trackingDetail.targetVariants")}</h2>
        <span class="text-xs text-muted-foreground">
          {t("trackingDetail.targetVariantsHint")}
        </span>
      </div>

      {#if linkedVariants.length === 0}
        <p class="text-sm text-muted-foreground">
          {t("trackingDetail.noVariantsLinked")}
        </p>
      {:else}
        <ul class="divide-y rounded-md border">
          {#each paginatedLinkedVariants as v (v.variantId)}
            <li class="flex items-center justify-between px-3 py-2 text-sm">
              <span>
                <a
                  href={`/products/${v.productId}`}
                  class="font-medium text-primary hover:underline"
                >
                  {v.productName}
                </a>
                <span class="ml-2 font-mono text-xs text-muted-foreground">
                  {v.sku}{v.label ? ` · ${v.label}` : ""}
                </span>
              </span>
              <IconButton
                icon={Trash2}
                label={t("trackingDetail.removeLink")}
                variant="destructive"
                disabled={busy || !canEdit}
                onclick={() => removeVariantLink(v.variantId)}
              />
            </li>
          {/each}
        </ul>
        {#if linkedVariants.length > pageSize}
          <div class="mt-2 flex items-center justify-between">
            <p class="text-sm text-muted-foreground">
              {t("trackingDetail.variantCount", { count: linkedVariants.length })}
            </p>
            <Pagination bind:page={variantsPage} {pageSize} totalItems={linkedVariants.length} />
          </div>
        {/if}
      {/if}

      {#if canEdit}
        <div class="mt-3 space-y-1">
          <span class="text-xs font-medium">{t("trackingDetail.addVariant")}</span>
          <div class="relative">
            <Input
              type="search"
              placeholder={t("tracking.searchByProduct")}
              bind:value={variantSearch}
              disabled={busy}
              onfocus={() => (pickerOpen = true)}
              onblur={() => setTimeout(() => (pickerOpen = false), 150)}
              onkeydown={onPickerKey}
              autocomplete="off"
            />
            {#if pickerOpen && pickableMatches.length > 0}
              <ul
                class="absolute z-10 mt-1 max-h-72 w-full overflow-auto rounded-md border bg-popover shadow-md"
              >
                {#each pickableMatches as v, i (v.variantId)}
                  <li>
                    <button
                      type="button"
                      class="w-full px-3 py-2 text-left text-sm hover:bg-muted/60 {i ===
                      highlight
                        ? 'bg-muted/60'
                        : ''}"
                      onmousedown={(e) => e.preventDefault()}
                      onmouseenter={() => (highlight = i)}
                      onclick={() => addVariantLink(v.variantId)}
                    >
                      <span class="font-medium">{v.productName}</span>
                      <span class="ml-2 font-mono text-xs text-muted-foreground">
                        {v.sku}{v.label ? ` · ${v.label}` : ""}
                      </span>
                      {#if v.currentTrackingAccountId}
                        <span class="ml-2 text-xs text-amber-700">
                          {t("trackingDetail.currently", { name: v.currentTrackingAccountName ?? t("trackingDetail.anotherAccount") })}
                        </span>
                      {/if}
                    </button>
                  </li>
                {/each}
              </ul>
            {:else if pickerOpen && variantSearch.trim()}
              <div
                class="absolute z-10 mt-1 w-full rounded-md border bg-popover px-3 py-2 text-sm text-muted-foreground shadow-md"
              >
                {t("trackingDetail.noMatches")}
              </div>
            {/if}
          </div>
        </div>
        <p class="mt-1 text-xs text-muted-foreground">
          {t("trackingDetail.linkReassignsHint")}
        </p>
      {/if}
    </div>

    <!-- Ledger -->
    <div class="space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="text-sm font-semibold">{t("trackingDetail.ledger")}</h2>
        <div class="flex flex-wrap items-center gap-2">
          <Input
            type="search"
            placeholder={t("tracking.searchNoteOrRef")}
            bind:value={ledgerSearch}
            class="w-48 text-xs"
          />
          <Select bind:value={ledgerTypeFilter} class="w-40 text-xs">
            <option value="all">{t("tracking.allTypes")}</option>
            <option value="attribution">{t("tracking.attribution")}</option>
            <option value="payout">{t("tracking.payout")}</option>
            <option value="deposit">{t("tracking.deposit")}</option>
            <option value="adjustment">{t("tracking.adjustment")}</option>
            <option value="opening_balance">{t("tracking.openingBalance")}</option>
          </Select>
        </div>
      </div>
      <div class="overflow-hidden rounded-lg border bg-card">
        <table class="w-full text-sm">
          <thead class="border-b bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th class="px-4 py-2 font-medium">{t("trackingDetail.when")}</th>
              <th class="px-4 py-2 font-medium">{t("common.type")}</th>
              <th class="px-4 py-2 font-medium">{t("trackingDetail.reference")}</th>
              <th class="px-4 py-2 font-medium">{t("common.note")}</th>
              <th class="px-4 py-2 text-right font-medium">{t("common.amount")}</th>
              <th class="px-4 py-2 text-right font-medium">{t("common.balance")}</th>
            </tr>
          </thead>
          <tbody>
            {#each paginatedLedger as e (e.id)}
              <tr class="border-b last:border-0">
                <td class="px-4 py-2">{fmtDateTime(e.createdAt)}</td>
                <td class="px-4 py-2 capitalize">{t(`tracking.${e.type === "opening_balance" ? "openingBalance" : e.type}`)}</td>
                <td class="px-4 py-2 text-xs">
                  {#if e.refType === "order_item" || e.refType === "order"}
                    <a
                      href={`/orders/${e.refId}`}
                      class="font-mono text-primary hover:underline"
                    >
                      {e.refType} · {e.refId?.slice(-8) ?? ""}
                    </a>
                  {:else if e.refType}
                    <span class="font-mono text-muted-foreground">
                      {e.refType}
                      {#if e.refId}· {e.refId.slice(-8)}{/if}
                    </span>
                  {:else}
                    —
                  {/if}
                </td>
                <td class="px-4 py-2 text-muted-foreground">{e.note ?? "—"}</td>
                <td
                  class="px-4 py-2 text-right font-medium
                    {e.amountMinor < 0 ? 'text-destructive' : ''}"
                >
                  {formatMoney(e.amountMinor)}
                </td>
                <td class="px-4 py-2 text-right font-medium tabular-nums">
                  {formatMoney(e.balanceAfter)}
                </td>
              </tr>
            {/each}
            {#if filteredLedger.length === 0}
              <tr>
                <td colspan="6" class="px-4 py-8 text-center text-muted-foreground">
                  {#if ledger.length === 0}
                    {t("trackingDetail.noLedgerEntries")}
                  {:else}
                    {t("trackingDetail.noMatchingLedger")}
                  {/if}
                </td>
              </tr>
            {/if}
          </tbody>
        </table>
      </div>
      {#if filteredLedger.length > 0}
        <div class="mt-2 flex items-center justify-between">
          <p class="text-sm text-muted-foreground">
            {t("trackingDetail.ledgerCount", { count: filteredLedger.length })}
            {#if filteredLedger.length !== ledger.length}
              {t("trackingDetail.filteredFrom", { count: ledger.length })}
            {/if}
          </p>
          <Pagination bind:page={ledgerPage} {pageSize} totalItems={filteredLedger.length} />
        </div>
      {/if}
    </div>
  {/if}
</div>
