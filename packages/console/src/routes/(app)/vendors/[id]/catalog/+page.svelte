<script lang="ts">
  import { CachePolicy, graphql } from "$houdini";
  import { page } from "$app/state";
  import type { Viewer } from "../../../+layout.server";
  import { formatMoney } from "$lib/utils";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Combobox from "$lib/components/ui/combobox.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import MoneyInput from "$lib/components/ui/money-input.svelte";
  import NumericInput from "$lib/components/ui/numeric-input.svelte";
  import Textarea from "$lib/components/ui/textarea.svelte";
  import { t } from "$lib/i18n";
  import type { PageData } from "./$types";

  // Header only: vendor needs just `vendor.edit` (which every viewer who can
  // open the vendor detail has). The items/imports live in a separate lazy
  // document below — a missing `vendor.catalog.manage` must show an honest
  // permission error, never a bogus "vendor not found" (a FORBIDDEN on the
  // non-null catalogItems field would null this whole query otherwise).
  graphql(`
    query VendorCatalog($vendorId: ID!) {
      vendor(id: $vendorId) {
        id
        name
        archivedAt
      }
    }
  `);

  // Pricelist rows + import trail, fetched lazily for viewers holding
  // `vendor.catalog.manage` (same pattern as the detail page's ledger/codes).
  const CatalogItems = graphql(`
    query ConsoleCatalogItems($vendorId: ID!) {
      catalogItems(vendorId: $vendorId) {
        id
        vendorCode
        name
        unitText
        priceMinor
        moq
        leadTimeDays
        validFrom
        validTo
        isActive
        mappedVariantId
        note
        lastSeenAt
        archivedAt
        isStale
        mappedVariant {
          id
          sku
          label
        }
      }
      catalogImports(vendorId: $vendorId) {
        id
        fileName
        status
        rowCount
        modelUsed
        createdAt
      }
    }
  `);

  // Variant catalogue for the link picker — fetched lazily like the vendor
  // detail's code panel.
  const CatalogVariants = graphql(`
    query ConsoleCatalogVariants {
      products(includeArchived: false) {
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

  const CreateCatalogItem = graphql(`
    mutation ConsoleCreateCatalogItem(
      $vendorId: ID!
      $vendorCode: String
      $name: String!
      $unitText: String
      $priceMinor: Float!
      $moq: Int
      $note: String
      $validTo: String
    ) {
      createCatalogItem(
        vendorId: $vendorId
        vendorCode: $vendorCode
        name: $name
        unitText: $unitText
        priceMinor: $priceMinor
        moq: $moq
        note: $note
        validTo: $validTo
      ) {
        id
      }
    }
  `);

  const UpdateCatalogItem = graphql(`
    mutation ConsoleUpdateCatalogItem(
      $id: ID!
      $vendorCode: String
      $name: String
      $unitText: String
      $priceMinor: Float
      $moq: Int
      $note: String
      $validTo: String
    ) {
      updateCatalogItem(
        id: $id
        vendorCode: $vendorCode
        name: $name
        unitText: $unitText
        priceMinor: $priceMinor
        moq: $moq
        note: $note
        validTo: $validTo
      ) {
        id
      }
    }
  `);

  const SetCatalogItemArchived = graphql(`
    mutation ConsoleSetCatalogItemArchived($id: ID!, $archived: Boolean!) {
      setCatalogItemArchived(id: $id, archived: $archived) {
        id
      }
    }
  `);

  const LinkCatalogItem = graphql(`
    mutation ConsoleLinkCatalogItem($id: ID!, $variantId: ID!) {
      linkCatalogItem(id: $id, variantId: $variantId) {
        id
      }
    }
  `);

  const UnlinkCatalogItem = graphql(`
    mutation ConsoleUnlinkCatalogItem($id: ID!) {
      unlinkCatalogItem(id: $id) {
        id
      }
    }
  `);

  const ConfirmCatalogImport = graphql(`
    mutation ConsoleConfirmCatalogImport(
      $importId: ID!
      $vendorId: ID!
      $rows: [CatalogImportRowInput!]!
    ) {
      confirmCatalogImport(importId: $importId, vendorId: $vendorId, rows: $rows) {
        created
        updated
        skipped
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const VendorCatalog = $derived(data.VendorCatalog);
  const vendor = $derived($VendorCatalog.data?.vendor);
  const vendorError = $derived($VendorCatalog.errors?.[0]?.message);
  const items = $derived($CatalogItems.data?.catalogItems ?? []);
  const imports = $derived($CatalogItems.data?.catalogImports ?? []);
  const itemsError = $derived($CatalogItems.errors?.[0]?.message);

  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canManage = $derived(has("vendor.catalog.manage"));
  const canImport = $derived(has("vendor.catalog.import"));

  // Lazy items load — once, for permitted viewers. Failures land in
  // $CatalogItems.errors and render as an honest message (never "not found").
  let itemsLoaded = $state(false);
  $effect(() => {
    if (vendor && canManage && !itemsLoaded) {
      itemsLoaded = true;
      CatalogItems.fetch({ variables: { vendorId: vendor.id } });
    }
  });

  let busy = $state(false);
  let feedback = $state<{ ok: boolean; text: string } | null>(null);
  const run = async (what: string, fn: () => Promise<unknown>) => {
    busy = true;
    feedback = null;
    try {
      await fn();
      feedback = { ok: true, text: `${what} saved.` };
      return true;
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
      return false;
    } finally {
      busy = false;
    }
  };
  const refetch = async () => {
    if (!vendor) return;
    // The items document is the one mutations change; the header rarely does.
    await CatalogItems.fetch({
      variables: { vendorId: vendor.id },
      policy: CachePolicy.NetworkOnly,
    });
  };

  // ---- Search (client-side; catalogs are hundreds of rows at most) ---------
  let search = $state("");
  const filtered = $derived.by(() => {
    const q = search.trim().toLowerCase();
    const rows = showArchived ? items : items.filter((i) => !i.archivedAt);
    if (!q) return rows;
    return rows.filter((i) =>
      `${i.name} ${i.vendorCode}`.toLowerCase().includes(q),
    );
  });
  let showArchived = $state(false);
  const staleCount = $derived(items.filter((i) => !i.archivedAt && i.isStale).length);

  // ---- Add / edit form ------------------------------------------------------
  interface ItemForm {
    id: string | null;
    vendorCode: string;
    name: string;
    unitText: string;
    priceMinor: number | null;
    moq: number | null;
    note: string;
    validTo: string;
  }
  const emptyForm = (): ItemForm => ({
    id: null,
    vendorCode: "",
    name: "",
    unitText: "",
    priceMinor: null,
    moq: null,
    note: "",
    validTo: "",
  });
  let formOpen = $state(false);
  let form = $state<ItemForm>(emptyForm());
  const openAdd = () => {
    form = emptyForm();
    formOpen = true;
  };
  const openEdit = (row: (typeof items)[number]) => {
    form = {
      id: row.id,
      vendorCode: row.vendorCode,
      name: row.name,
      unitText: row.unitText ?? "",
      priceMinor: row.priceMinor,
      moq: row.moq,
      note: row.note ?? "",
      validTo: row.validTo ?? "",
    };
    formOpen = true;
  };
  async function saveForm() {
    const price = form.priceMinor;
    if (!vendor || price == null) return;
    const ok = await run("Catalog item", () =>
      form.id
        ? UpdateCatalogItem.mutate({
            id: form.id,
            vendorCode: form.vendorCode.trim(),
            name: form.name.trim(),
            unitText: form.unitText.trim() || null,
            priceMinor: price,
            moq: form.moq,
            note: form.note.trim() || null,
            validTo: form.validTo || null,
          })
        : CreateCatalogItem.mutate({
            vendorId: vendor.id,
            vendorCode: form.vendorCode.trim() || null,
            name: form.name.trim(),
            unitText: form.unitText.trim() || null,
            priceMinor: price,
            moq: form.moq,
            note: form.note.trim() || null,
            validTo: form.validTo || null,
          }),
    );
    if (ok) {
      formOpen = false;
      await refetch();
    }
  }
  async function toggleArchived(row: (typeof items)[number]) {
    const ok = await run("Catalog item", () =>
      SetCatalogItemArchived.mutate({ id: row.id, archived: row.archivedAt == null }),
    );
    if (ok) await refetch();
  }

  // ---- Link picker ----------------------------------------------------------
  let variantsLoaded = $state(false);
  $effect(() => {
    if (vendor && canManage && !variantsLoaded) {
      variantsLoaded = true;
      CatalogVariants.fetch();
    }
  });
  const allProducts = $derived($CatalogVariants.data?.products ?? []);
  const variantOptions = $derived.by(() => {
    const out: { value: string; label: string }[] = [];
    for (const p of allProducts) {
      for (const v of p.variants) {
        out.push({
          value: v.id,
          label: `${p.name} · ${v.label ? `${v.sku} · ${v.label}` : v.sku}`,
        });
      }
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  });
  let linkingId = $state<string | null>(null);
  let linkingVariant = $state("");
  async function saveLink() {
    const id = linkingId;
    const variantId = linkingVariant;
    if (!id || !variantId) return;
    const ok = await run("Link", () =>
      LinkCatalogItem.mutate({ id, variantId }),
    );
    if (ok) {
      linkingId = null;
      linkingVariant = "";
      await refetch();
    }
  }
  async function unlink(row: (typeof items)[number]) {
    const ok = await run("Link", () => UnlinkCatalogItem.mutate({ id: row.id }));
    if (ok) await refetch();
  }

  // ---- File import → preview → confirm --------------------------------------
  interface PreviewRow {
    key: string;
    vendorCode: string;
    name: string;
    unitText: string;
    priceMinor: number | null;
    moq: number | null;
    note: string;
    matchedItemId: string | null;
    matchedName: string | null;
    oldPriceMinor: number | null;
    action: "update" | "create";
    accepted: boolean;
  }
  let uploading = $state(false);
  let previewImportId = $state<string | null>(null);
  let previewSource = $state("");
  let preview = $state<PreviewRow[]>([]);
  const previewAccepted = $derived(preview.filter((r) => r.accepted));

  async function uploadFile(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file || !vendor) return;
    uploading = true;
    feedback = null;
    try {
      const body = new FormData();
      body.append("file", file, file.name);
      const res = await fetch(`./import`, { method: "POST", body });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.message ?? payload?.error ?? `Upload failed (${res.status})`);
      previewImportId = payload.importId;
      previewSource = payload.source ?? "";
      // Updates are pre-accepted (price proposals); new rows need explicit
      // accept per the re-import rule.
      preview = (payload.rows ?? []).map((r: PreviewRow) => ({
        ...r,
        accepted: r.action === "update",
      }));
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
    } finally {
      uploading = false;
    }
  }

  async function confirmImport() {
    if (!vendor || !previewImportId) return;
    const rows = previewAccepted.map((r) => ({
      vendorCode: r.vendorCode,
      name: r.name,
      unitText: r.unitText || null,
      priceMinor: r.priceMinor,
      moq: r.moq,
      note: r.note || null,
      matchedItemId: r.action === "update" ? r.matchedItemId : null,
    }));
    const ok = await run("Import", () =>
      ConfirmCatalogImport.mutate({
        importId: previewImportId!,
        vendorId: vendor.id,
        rows,
      }),
    );
    if (ok) {
      preview = [];
      previewImportId = null;
      await refetch();
    }
  }

  const fmtMoney = (n: number) => formatMoney(n);
  const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString("id-ID") : "—");
</script>

<svelte:head>
  <title>{vendor ? `${vendor.name} · Catalog` : "Catalog"} · Retale Console</title>
</svelte:head>

<div class="mx-auto max-w-5xl space-y-6">
  <a
    href={vendor ? `/vendors/${vendor.id}` : "/vendors"}
    class="text-sm text-muted-foreground hover:text-foreground"
    >{t("vendorCatalog.backToVendor")}</a
  >

  {#if $VendorCatalog.fetching && !vendor && !vendorError}
    <p class="text-sm text-muted-foreground">{t("common.loading")}</p>
  {:else if vendorError}
    <p class="text-sm text-destructive">{vendorError}</p>
  {:else if !vendor}
    <p class="text-sm text-destructive">{t("vendorCatalog.vendorNotFound")}</p>
  {:else}
    <div class="flex items-start justify-between gap-4">
      <div>
        <h1 class="text-xl font-semibold">
          {vendor.name} · {t("vendorCatalog.title")}
        </h1>
        <p class="text-sm text-muted-foreground">
          {t("vendorCatalog.referenceOnly")}
          {#if staleCount > 0}
            <span class="font-medium text-amber-700">
              · {t("vendorCatalog.staleCount", { count: String(staleCount) })}
            </span>
          {/if}
          {#if imports[0]}
            <span> · {t("vendorCatalog.lastImport", { name: imports[0].fileName ?? "—" })}</span>
          {/if}
        </p>
      </div>
      <div class="flex items-center gap-2">
        {#if canManage && canImport}
          <label class="inline-flex cursor-pointer items-center">
            <span class="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted">
              {uploading ? t("vendorCatalog.uploading") : t("vendorCatalog.importFile")}
            </span>
            <input
              type="file"
              class="hidden"
              accept=".csv,.txt,.xlsx,.xls,.pdf,.jpg,.jpeg,.png,.webp"
              disabled={uploading}
              onchange={uploadFile}
            />
          </label>
        {/if}
        {#if canManage}
          <Button size="sm" onclick={openAdd}>{t("vendorCatalog.addItem")}</Button>
        {/if}
      </div>
    </div>

    {#if feedback}
      <p class="text-sm {feedback.ok ? 'text-emerald-700' : 'text-destructive'}">
        {feedback.text}
      </p>
    {/if}

    {#if !canManage}
      <p class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
        {t("vendorCatalog.noAccessNotice")}
      </p>
    {:else if $CatalogItems.fetching && items.length === 0 && !itemsError}
      <p class="text-sm text-muted-foreground">{t("common.loading")}</p>
    {:else}
      {#if itemsError}
        <p class="text-sm text-destructive">{itemsError}</p>
      {/if}

    <!-- Search -->
    <div class="flex items-center gap-3">
      <Input
        bind:value={search}
        placeholder={t("vendorCatalog.searchPlaceholder")}
        class="max-w-sm"
      />
      <label class="flex items-center gap-1.5 text-sm text-muted-foreground">
        <input type="checkbox" bind:checked={showArchived} />
        {t("vendorCatalog.showArchived")}
      </label>
    </div>

    <!-- Table -->
    <section class="overflow-x-auto rounded-lg border bg-card">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b text-left text-muted-foreground">
            <th class="px-3 py-2">{t("vendorCatalog.code")}</th>
            <th class="px-3 py-2">{t("common.name")}</th>
            <th class="px-3 py-2">{t("vendorCatalog.unit")}</th>
            <th class="px-3 py-2 text-right">{t("vendorCatalog.moq")}</th>
            <th class="px-3 py-2 text-right">{t("vendorCatalog.price")}</th>
            <th class="px-3 py-2">{t("vendorCatalog.validity")}</th>
            <th class="px-3 py-2">{t("vendorCatalog.linkedVariant")}</th>
            {#if canManage}<th class="px-3 py-2"></th>{/if}
          </tr>
        </thead>
        <tbody>
          {#each filtered as row (row.id)}
            <tr class="border-b last:border-0 {row.archivedAt ? 'opacity-50' : ''}">
              <td class="px-3 py-2 font-mono text-xs">{row.vendorCode || "—"}</td>
              <td class="px-3 py-2">
                {row.name}
                {#if row.isStale && !row.archivedAt}
                  <Badge class="ml-1 bg-amber-100 text-amber-800">{t("vendorCatalog.stale")}</Badge>
                {/if}
                {#if row.note}
                  <p class="text-xs text-muted-foreground">{row.note}</p>
                {/if}
              </td>
              <td class="px-3 py-2">{row.unitText ?? "—"}</td>
              <td class="px-3 py-2 text-right">{row.moq ?? "—"}</td>
              <td class="px-3 py-2 text-right font-medium">{fmtMoney(row.priceMinor)}</td>
              <td class="px-3 py-2 text-xs text-muted-foreground">
                {row.validTo ? fmtDate(row.validTo) : t("vendorCatalog.noExpiry")}
              </td>
              <td class="px-3 py-2 text-xs">
                {#if row.mappedVariant}
                  <span>{row.mappedVariant.sku}{row.mappedVariant.label ? ` · ${row.mappedVariant.label}` : ""}</span>
                  {#if canManage}
                    <button class="ml-1 underline text-muted-foreground" onclick={() => unlink(row)}>
                      {t("vendorCatalog.unlink")}
                    </button>
                  {/if}
                {:else if canManage}
                  <button class="underline" onclick={() => { linkingId = row.id; linkingVariant = ""; }}>
                    {t("vendorCatalog.link")}
                  </button>
                {:else}—{/if}
              </td>
              {#if canManage}
                <td class="px-3 py-2 text-right whitespace-nowrap">
                  <button class="underline" onclick={() => openEdit(row)}>{t("common.edit")}</button>
                  <button class="ml-2 underline text-muted-foreground" onclick={() => toggleArchived(row)}>
                    {row.archivedAt ? t("addresses.restore") : t("addresses.archive")}
                  </button>
                </td>
              {/if}
            </tr>
          {:else}
            <tr>
              <td colspan={canManage ? 8 : 7} class="px-3 py-6 text-center text-muted-foreground">
                {t("vendorCatalog.empty")}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>

    <!-- Link picker -->
    {#if linkingId && canManage}
      <section class="space-y-3 rounded-lg border bg-card p-5">
        <h2 class="text-sm font-semibold">{t("vendorCatalog.linkTitle")}</h2>
        <Combobox
          options={variantOptions}
          bind:value={linkingVariant}
          placeholder={t("vendorCatalog.pickVariant")}
        />
        <div class="flex gap-2">
          <Button size="sm" disabled={busy || !linkingVariant} onclick={saveLink}>
            {t("vendorCatalog.link")}
          </Button>
          <Button size="sm" variant="outline" onclick={() => { linkingId = null; }}>
            {t("common.cancel")}
          </Button>
        </div>
      </section>
    {/if}

    <!-- Add / edit -->
    {#if formOpen && canManage}
      <section class="space-y-4 rounded-lg border bg-card p-5">
        <h2 class="text-sm font-semibold">
          {form.id ? t("vendorCatalog.editItem") : t("vendorCatalog.addItem")}
        </h2>
        <div class="grid grid-cols-2 gap-4">
          <label class="space-y-1">
            <span class="text-sm font-medium">{t("vendorCatalog.code")}</span>
            <Input bind:value={form.vendorCode} placeholder="SUP-123" />
          </label>
          <label class="space-y-1">
            <span class="text-sm font-medium">{t("common.name")} *</span>
            <Input bind:value={form.name} />
          </label>
          <label class="space-y-1">
            <span class="text-sm font-medium">{t("vendorCatalog.unit")}</span>
            <Input bind:value={form.unitText} placeholder="pcs / dus / koli" />
          </label>
          <label class="space-y-1">
            <span class="text-sm font-medium">{t("vendorCatalog.price")} (Rp) *</span>
            <MoneyInput bind:value={form.priceMinor} />
          </label>
          <label class="space-y-1">
            <span class="text-sm font-medium">{t("vendorCatalog.moq")}</span>
            <NumericInput bind:value={form.moq} />
          </label>
          <label class="space-y-1">
            <span class="text-sm font-medium">{t("vendorCatalog.validTo")}</span>
            <Input type="date" bind:value={form.validTo} />
          </label>
          <label class="col-span-2 space-y-1">
            <span class="text-sm font-medium">{t("common.note")}</span>
            <Textarea bind:value={form.note} rows={2} />
          </label>
        </div>
        <div class="flex gap-2">
          <Button
            size="sm"
            disabled={busy || !form.name.trim() || form.priceMinor == null}
            onclick={saveForm}
          >
            {t("common.save")}
          </Button>
          <Button size="sm" variant="outline" onclick={() => { formOpen = false; }}>
            {t("common.cancel")}
          </Button>
        </div>
      </section>
    {/if}

    <!-- Import preview -->
    {#if preview.length > 0}
      <section class="space-y-3 rounded-lg border bg-card p-5">
        <h2 class="text-sm font-semibold">
          {t("vendorCatalog.previewTitle", { source: previewSource, count: String(previewAccepted.length) })}
        </h2>
        <div class="max-h-96 overflow-y-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b text-left text-muted-foreground">
                <th class="px-2 py-1"></th>
                <th class="px-2 py-1"></th>
                <th class="px-2 py-1">{t("common.name")}</th>
                <th class="px-2 py-1 text-right">{t("vendorCatalog.price")}</th>
              </tr>
            </thead>
            <tbody>
              {#each preview as r (r.key)}
                <tr class="border-b last:border-0">
                  <td class="px-2 py-1">
                    <input type="checkbox" bind:checked={r.accepted} />
                  </td>
                  <td class="px-2 py-1">
                    <Badge class={r.action === "update" ? "bg-sky-100 text-sky-800" : "bg-emerald-100 text-emerald-700"}>
                      {r.action === "update" ? t("vendorCatalog.update") : t("vendorCatalog.new")}
                    </Badge>
                  </td>
                  <td class="px-2 py-1">
                    <span class="font-mono text-xs text-muted-foreground">{r.vendorCode}</span>
                    {r.name}
                    {#if r.action === "update"}
                      <p class="text-xs text-muted-foreground">→ {r.matchedName}</p>
                    {/if}
                  </td>
                  <td class="px-2 py-1 text-right">
                    {#if r.action === "update" && r.oldPriceMinor != null}
                      <span class="text-muted-foreground line-through">{fmtMoney(r.oldPriceMinor)}</span>
                      →
                    {/if}
                    {r.priceMinor != null ? fmtMoney(r.priceMinor) : t("vendorCatalog.noPrice")}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <div class="flex gap-2">
          <Button size="sm" disabled={busy || previewAccepted.length === 0} onclick={confirmImport}>
            {t("vendorCatalog.confirmImport")}
          </Button>
          <Button size="sm" variant="outline" onclick={() => { preview = []; previewImportId = null; }}>
            {t("common.cancel")}
          </Button>
        </div>
      </section>
    {/if}
    {/if}
  {/if}
</div>
