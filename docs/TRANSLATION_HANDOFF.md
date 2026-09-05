# i18n Translation Handoff (Bahasa Indonesia)

Status: **complete — committed**. Console + POS fully translated (en/id key sets equal); see final commit.

Goal: translate every user-facing string in the **Console** (SvelteKit admin) and **POS** (Flutter register) to
Bahasa Indonesia. Only two languages are kept: **English** (`en`, the source/fallback) and **Bahasa Indonesia**
(`id`). Never translate product/vendor/customer/register/location names or other user-supplied data, brand
"Retale", currency "Rp", SKUs, or API enum *values* stored in the DB (only their *display labels*).

---

## What is DONE

### POS (`packages/pos`) — complete
- `assets/i18n/en.json` + `id.json` (197 keys, equal key sets), `lib/i18n/i18n_service.dart`.
- Hardcoded strings replaced across `lib/` (`register_screen.dart`, `order_history_screen.dart`,
  `session_screen.dart`, `login_screen.dart`, `two_factor_screen.dart`, `pos_selection_screen.dart`,
  `api_setup_screen.dart`, `main.dart`, `auth/`, `graphql/`, `receipt/`, `widgets/`).
- `flutter analyze` was clean. Intentionally left: brand "Retale POS", unit symbol "Units", placeholder
  store name "Receipt", API-derived order status / payment method strings.

### Console (`packages/console`) — mostly done
i18n infra: `src/lib/i18n/i18n.svelte.ts` (reactive `t(key, params?)`), `packs/en.json` + `packs/id.json`
(~1660 keys, **equal key sets — verified**). `t()` supports `{param}` interpolation and `"singular|plural"`
pluralization selected by a numeric `count` param.

Fully translated (verified): `products/{+page,[id],bulk}`, `orders/{+page,[id]}`, `customers/{+page,[id]}`,
plus `lib/components/ui/pagination.svelte`, `duplicate-hint.svelte`, and the ledger-type cell fix in
`vendors/[id]`. The earlier session already translated `account`, `catalog`, `categories`,
`interchange-groups/*`, `locations`, `requisitions/*`, `settings/*`, `stock`, `transfers/*`, `vendors/+page`,
`(app)/+layout.svelte`, `(app)/+page.svelte`, `login`.

### What remains (finish these)
Not yet started (no `import { t }` yet):
- `alerts/+page.svelte`
- `registers/+page.svelte`
- `reorder/+page.svelte`, `reorder/budget/+page.svelte`
- `reports/+page.svelte`
- `roles/+page.svelte`
- `sessions/+page.svelte`, `sessions/[id]/+page.svelte`, `sessions/[id]/variants/+page.svelte`
- `tracking/+page.svelte`, `tracking/[id]/+page.svelte`
- `users/+page.svelte`

Partially done by a cancelled subagent — **verify and finish** (imports added, many keys added, but
completeness unverified; re-grep each):
- `purchases/+page.svelte`, `purchases/[id]/+page.svelte`, `purchases/[id]/discount-modal.svelte`,
  `purchases/[id]/pull-requisition-modal.svelte`, `purchases/[id]/receive/+page.svelte`
- `deliveries/+page.svelte`, `deliveries/[id]/+page.svelte`
- `rfqs/+page.svelte`, `rfqs/[id]/+page.svelte`, `rfqs/[id]/print/+page.svelte`

---

## The pattern (follow exactly)

In each `.svelte` file:
```svelte
<script lang="ts">
  import { t } from "$lib/i18n";
  ...
</script>
...
{t("key")}                    // plain
{t("key", { count: n })}      // interpolation
placeholder={t("key")}
title={t("key")}  aria-label={t("key")}  label={t("key")}
```

Add keys to **BOTH** `packs/en.json` and `packs/id.json`, appended at the end (before the final `}`),
keeping en and id in the same order. Reuse existing keys when the exact English text already exists
(grep `packs/en.json` first).

Pluralization: en uses `"One {count} item|{count} items"`; id uses a single `"{count} item"` (no `|`).

### Conventions already established
- Namespaces by domain: `common.`, `nav.`, `products.`, `orders.`, `orderDetail.`, `customers.`,
  `customerDetail.`, `purchases.`, `purchaseReceive.`, `purchaseDiscount.`, `pullRequisition.`,
  `deliveries.`, `rfqs.`, `rfqPrint.`, `reorder.`, `alerts.`, `reports.`, `roles.`, `users.`,
  `registers.`, `sessions.`, `tracking.`, `requisitions.`, `ledgerType.`, `duplicateHint.`, etc.
- Ledger `type` cells: replace `statusLabel(e.type)` with `{t(`ledgerType.${e.type}`)}`. Keys exist:
  `sale_on_account`, `purchase_on_account`, `payment`, `refund_credit`, `adjustment`,
  `opening_balance`, `attribution`, `payout`, `deposit`.
- Enum/status labels: check the GraphQL enum values in `packages/api/src/schema/*.ts`
  (e.g. `CustomerLedgerType`, `VendorLedgerType`, `TrackingLedgerType`, order/purchase/delivery/rfq
  status enums) and add `domain.status.<value>` keys, rendering `{t(`domain.status.${value}`)}`.
- Remove `statusLabel` from a file's `$lib/utils` import when it is no longer used.

### Indonesian terminology reference (match this style)
Simpan/Batal/Hapus/Ubah/Tambah/Cari/Muat/Tutup, Pemasok, Pelanggan, Pesanan, Produk, Varian, Stok,
Lokasi, Kategori, Diskon, Subtotal, Total, Modal (cost), Harga (price), Penerimaan (receiving),
Pengiriman (delivery), Penyesuaian (adjustment), Penawaran (quote), Draf, Terbuka, Dibatalkan,
Selesai, Diarsipkan, Aktif, Belum lunas (outstanding), Saldo piutang (AR), Saldo hutang (AP).

---

## Verify (run these)

```bash
# 1. key-set equality (MUST print "<n> <n> True")
cd /home/ajin/projects/retale/packages/console
python3 -c "import json; e=json.load(open('src/lib/i18n/packs/en.json')); i=json.load(open('src/lib/i18n/packs/id.json')); print(len(e), len(i), set(e)==set(i))"

# 2. find leftover hardcoded English (ignore code/type-annotation false positives)
grep -rnE ">[[:space:]]*[A-Za-z][A-Za-z ,.'’()…-]{3,}[[:space:]]*<|placeholder=\"[A-Z]|title=\"[A-Z]|aria-label=\"[A-Z]|label=\"[A-Z]|confirm\(" src/routes/\(app\)/

# 3. full typecheck / build (when balance allows — may need houdini generate)
cd /home/ajin/projects/retale/packages/console && bun run check   # or: bun run build
```

---

## Notes / gotchas
- `t()` was extended to handle the `|` plural form (see `i18n.svelte.ts`). Don't revert.
- `duplicate-hint.svelte` localizes its `noun` prop via `t(`common.${noun}`)`; the nouns used are
  `product`, `vendor`, `category`, `customer`, `group` (keys exist under `common.*`).
- Known minor leave-as-is: `products/[id]` bulk-variant dialog placeholder `Small&#10;Medium&#10;Large`
  (multiline HTML-entity example; left untranslated to avoid an attribute-newline rendering regression).
- Nothing has been committed. Commit when finished with a Conventional Commit, e.g.
  `feat(console, pos): add full Bahasa Indonesia translation`.
