<script lang="ts">
  import { graphql } from "$houdini";
  import Button from "$lib/components/ui/button.svelte";
  import Combobox from "$lib/components/ui/combobox.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import MoneyInput from "$lib/components/ui/money-input.svelte";
  import { t } from "$lib/i18n";
  import { formatMoney, roundMoney } from "$lib/utils";
  import { X } from "@lucide/svelte";

  let {
    open = $bindable(false),
    purchaseId,
    purchaseVendorId = null,
    vendorOptions = [],
    invoiceTotal = 0,
    onSaved,
  }: {
    open: boolean;
    purchaseId: string;
    purchaseVendorId: string | null;
    vendorOptions: { value: string; label: string }[];
    invoiceTotal: number;
    onSaved: () => void;
  } = $props();

  const MarkPurchasePaid = graphql(`
    mutation ConsoleMarkPurchasePaid(
      $purchaseId: ID!
      $vendorId: ID
      $amountMinor: Float
      $note: String
    ) {
      markPurchasePaid(
        purchaseId: $purchaseId
        vendorId: $vendorId
        amountMinor: $amountMinor
        note: $note
      ) {
        id
        vendorId
        snapshotVendorName
        paidAt
        paidAmountMinor
      }
    }
  `);

  let busy = $state(false);
  let error = $state<string | null>(null);
  // Prefill the full invoice total — v1 is full prepayment; anything less
  // simply leaves the remainder owed at delivery (no partial badge state).
  let amount = $state<number | null>(null);
  let note = $state("");
  let vendorId = $state("");

  let prevOpen = false;
  $effect(() => {
    if (open && !prevOpen) {
      amount = roundMoney(invoiceTotal);
      note = "";
      vendorId = "";
      error = null;
    }
    prevOpen = open;
  });

  const needsVendor = $derived(!purchaseVendorId);
  const canSave = $derived(
    !busy && amount != null && amount > 0 && (!needsVendor || vendorId !== ""),
  );

  async function save() {
    if (!canSave) return;
    busy = true;
    error = null;
    try {
      const res = await MarkPurchasePaid.mutate({
        purchaseId,
        vendorId: needsVendor ? vendorId : undefined,
        amountMinor: amount,
        note: note.trim() || undefined,
      });
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      open = false;
      onSaved();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

{#if open}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 sm:p-6">
    <div class="flex max-h-[90vh] w-full max-w-md flex-col rounded-lg bg-card shadow-lg ring-1 ring-border">
      <div class="flex shrink-0 items-center justify-between border-b p-4">
        <h2 class="text-lg font-semibold">{t("purchaseDetail.markPaidTitle")}</h2>
        <Button variant="ghost" size="icon" class="h-8 w-8 text-muted-foreground hover:text-foreground" onclick={() => open = false}>
          <X class="h-5 w-5" />
        </Button>
      </div>

      <div class="space-y-4 p-4 sm:p-6">
        {#if needsVendor}
          <div class="space-y-1">
            <span class="text-sm font-medium">{t("common.vendor")}</span>
            <Combobox
              options={vendorOptions.filter((o) => o.value !== "")}
              bind:value={vendorId}
              placeholder={t("purchases.searchVendor")}
            />
            <p class="text-xs text-muted-foreground">{t("purchaseDetail.markPaidVendorHint")}</p>
          </div>
        {/if}
        <div class="space-y-1">
          <span class="text-sm font-medium">{t("purchaseDetail.markPaidAmount")}</span>
          <MoneyInput autofocus bind:value={amount} />
          <p class="text-xs text-muted-foreground">
            {t("purchaseDetail.markPaidInvoiceTotal", { amount: formatMoney(invoiceTotal) })}
          </p>
        </div>
        <div class="space-y-1">
          <span class="text-sm font-medium">{t("purchaseDetail.optionalNote")}</span>
          <Input bind:value={note} placeholder={t("purchaseDetail.markPaidNotePlaceholder")} />
        </div>
        <p class="text-xs text-muted-foreground">{t("purchaseDetail.markPaidExplainer")}</p>
        {#if error}
          <p class="text-sm text-destructive">{error}</p>
        {/if}
      </div>

      <div class="flex shrink-0 items-center justify-end gap-3 border-t bg-muted/20 p-4">
        <Button variant="outline" disabled={busy} onclick={() => open = false}>{t("common.cancel")}</Button>
        <Button disabled={!canSave} onclick={save}>
          {busy ? t("purchaseDetail.markPaidSaving") : t("purchaseDetail.markPaidSave")}
        </Button>
      </div>
    </div>
  </div>
{/if}
