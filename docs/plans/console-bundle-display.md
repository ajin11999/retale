# Plan: Console — Bundle Product Component Display

**Goal:** When viewing a `kind = "bundle"` product in the Retale Console, the product detail page shows which component products/variants are inside the bundle, with their names, SKUs, and quantities.

**Constraint:** Display only — the `setBundleComponents` mutation already exists. Editing bundle composition is out of scope for this plan.

---

## 1. What exists already

| Layer | State |
|-------|-------|
| DB schema | `bundle_components` table: `id`, `bundleVariantId`, `componentVariantId`, `qty` |
| API service | `getBundleComponents(bundleVariantId)` returns raw rows |
| API schema | `ProductVariant.bundleComponents: [BundleComponent!]!` |
| API schema | `BundleComponent` type: `id`, `bundleVariantId`, `componentVariantId`, `qty` |
| API mutation | `setBundleComponents(bundleVariantId, components)` exists |
| Console | `ProductDetail` query does NOT ask for `bundleComponents` |
| Console | No bundle-specific UI section exists |

**Gap:** `BundleComponent` only carries `componentVariantId` (a raw ID). The console needs the component variant's SKU, label, and its parent product's name to render something useful. There's no `componentVariant` field on `BundleComponent`.

---

## 2. Step-by-step implementation

### Step A — Extend the `BundleComponent` GraphQL type (API)

**File:** `packages/api/src/schema/products.ts`

Add a `componentVariant` field to the `BundleComponent` type so it can resolve to the full `ProductVariant`:

```graphql
type BundleComponent {
    id: ID!
    bundleVariantId: ID!
    componentVariantId: ID!
    qty: Float!
    "The variant this component points to — its SKU, label, and parent product."
    componentVariant: ProductVariant!
}
```

Add the resolver in the same file. Find the existing resolver map (near line 207). Add a new `BundleComponent:` resolver block next to it:

```typescript
BundleComponent: {
    componentVariant: (bc: { componentVariantId: string }) =>
        products.getVariant(bc.componentVariantId),
},
```

Check whether `getVariant` already exists in `product-service.ts`. If not, create a thin wrapper:

```typescript
export async function getVariant(id: string) {
    return await loadVariant(id);
}
```

### Step B — Update Houdini query in the console product detail page

**File:** `packages/console/src/routes/(app)/products/[id]/+page.svelte`

In the `ProductDetail` query (around line 20–75), inside the `variants { ... }` block, after `stock { locationId qty }`, add:

```graphql
bundleComponents {
    id
    qty
    componentVariant {
        id
        sku
        label
        productId
    }
}
```

### Step C — Sync Houdini types

```bash
cd packages/console
bunx houdini generate
```

Or use the project's `houdini-sync` skill.

### Step D — Render the bundle components section (Console UI)

**File:** `packages/console/src/routes/(app)/products/[id]/+page.svelte`

After the variants table/list, add a conditional section that only renders when the product `kind === "bundle"`:

```svelte
{#if product.kind === "bundle"}
    <div class="space-y-2">
        <h2 class="text-lg font-semibold">Bundle components</h2>
        {#each product.variants as variant (variant.id)}
            {#if variant.bundleComponents?.length}
                <div class="rounded-lg border bg-card p-4">
                    <p class="text-sm font-medium">
                        Variant: {variant.label || variant.sku}
                    </p>
                    <ul class="mt-2 space-y-1">
                        {#each variant.bundleComponents as comp (comp.id)}
                            <li class="flex justify-between text-sm">
                                <span>
                                    {comp.componentVariant.label || comp.componentVariant.sku}
                                    <span class="text-xs text-muted-foreground ml-1">
                                        ({comp.componentVariant.sku})
                                    </span>
                                </span>
                                <span class="text-muted-foreground">×{comp.qty}</span>
                            </li>
                        {/each}
                    </ul>
                </div>
            {/if}
        {/each}
    </div>
{/if}
```

### Step E — Optional: Resolve component product name

If you want to show the component's parent product name (not just variant label/SKU), extend the query in step B to also fetch `componentVariant { ... product { name } }` and render it in the template.

---

## 3. Verification checklist

- [ ] API: `BundleComponent.componentVariant` returns valid `ProductVariant` with `id`, `sku`, `label`, `productId`
- [ ] API: Querying `bundleComponents { componentVariant { sku label } }` on a bundle variant returns correct data
- [ ] API: Querying the same on a non-bundle product returns empty array (no error)
- [ ] Console: Product detail page for a `kind = "bundle"` product shows the "Bundle components" section
- [ ] Console: Product detail page for a non-bundle product does NOT show the section
- [ ] Console: Each component line shows the variant identifier and quantity
- [ ] Console: Houdini types are regenerated and no TypeScript errors
- [ ] Run `bun run dev` in `packages/api` and `bun run dev:console` — verify visually

---

## 4. Notes

- **Permission:** No new permissions needed. Reading `bundleComponents` uses the existing `ProductDetail` query.
- **No migration:** Schema is unchanged — only the GraphQL type definition and resolver are extended.
- **Houdini:** The `houdini-sync` skill should be used after any GraphQL schema change.
- **Edge case:** A product whose `kind` was recently changed TO `bundle` may have no components yet — the `{#if variant.bundleComponents?.length}` guard handles this.
