<script lang="ts">
  import { page } from "$app/state";
  import type { Snippet } from "svelte";
  import type { LayoutServerData } from "./$types";

  let {
    data,
    children,
  }: { data: LayoutServerData; children: Snippet } = $props();

  // `perm` gates a link on a viewer permission; omit it to always show. Root
  // bypasses the check (permissions resolves to the full catalog for root).
  interface NavItem {
    href: string;
    label: string;
    perm?: string;
  }
  const NAV: NavItem[] = [
    { href: "/products", label: "Products" },
    { href: "/categories", label: "Categories" },
    { href: "/customers", label: "Customers" },
    { href: "/vendors", label: "Vendors" },
    { href: "/locations", label: "Locations" },
    { href: "/transfers", label: "Stock transfers" },
    { href: "/purchases", label: "Purchases" },
    { href: "/deliveries", label: "Deliveries", perm: "delivery.draft" },
    { href: "/reorder", label: "Reorder suggestions" },
    { href: "/orders", label: "Orders", perm: "report.sales.view" },
    { href: "/sessions", label: "POS sessions", perm: "session.open" },
    { href: "/tracking", label: "Tracking accounts", perm: "tracking_account.edit" },
    { href: "/alerts", label: "Alerts", perm: "alert.acknowledge" },
    { href: "/catalog", label: "Catalog", perm: "catalog.manage" },
    { href: "/reports", label: "Reports" },
    { href: "/users", label: "Users", perm: "admin.user.manage" },
    { href: "/roles", label: "Roles", perm: "admin.role.manage" },
    { href: "/settings", label: "Business settings", perm: "admin.settings.manage" },
    { href: "/account", label: "Account" },
  ];

  const perms = $derived(new Set(data.user.permissions ?? []));
  const nav = $derived(
    NAV.filter((n) => !n.perm || data.user.isRoot || perms.has(n.perm)),
  );

  const isActive = (href: string) =>
    page.url.pathname === href || page.url.pathname.startsWith(href + "/");
</script>

<div class="flex min-h-screen">
  <aside class="flex w-60 flex-col border-r bg-card">
    <div class="flex h-14 items-center border-b px-5 font-semibold">
      Retale Console
    </div>
    <nav class="flex-1 space-y-0.5 p-3">
      {#each nav as item (item.href)}
        <a
          href={item.href}
          class="block rounded-md px-3 py-2 text-sm transition-colors
            {isActive(item.href)
            ? 'bg-accent font-medium text-accent-foreground'
            : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'}"
        >
          {item.label}
        </a>
      {/each}
    </nav>
  </aside>

  <div class="flex flex-1 flex-col">
    <header
      class="flex h-14 items-center justify-between border-b bg-card px-6"
    >
      <div class="text-sm text-muted-foreground">
        {data.user.name}
        {#if data.user.isRoot}
          <span
            class="ml-1 rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary"
            >root</span
          >
        {/if}
      </div>
      <form method="POST" action="/logout">
        <button
          type="submit"
          class="text-sm text-muted-foreground hover:text-foreground"
        >
          Sign out
        </button>
      </form>
    </header>

    <main class="flex-1 p-6">
      {@render children()}
    </main>
  </div>
</div>
