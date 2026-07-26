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
  interface NavGroup {
    label: string;
    items: NavItem[];
  }
  const NAV: NavGroup[] = [
    {
      label: "Catalog",
      items: [
        { href: "/products", label: "Products" },
        { href: "/categories", label: "Categories" },
        { href: "/interchange-groups", label: "Interchange groups" },
        { href: "/catalog", label: "Catalog", perm: "catalog.manage" },
      ],
    },
    {
      label: "Inventory & Purchasing",
      items: [
        { href: "/locations", label: "Locations" },
        { href: "/transfers", label: "Stock transfers" },
        { href: "/vendors", label: "Vendors" },
        { href: "/requisitions", label: "Purchase Requisitions" },
        { href: "/purchases", label: "Purchases" },
        { href: "/deliveries", label: "Deliveries", perm: "delivery.draft" },
        { href: "/reorder", label: "Reorder suggestions" },
      ],
    },
    {
      label: "Sales",
      items: [
        { href: "/orders", label: "Orders", perm: "report.sales.view" },
        { href: "/customers", label: "Customers" },
        { href: "/registers", label: "Registers", perm: "pos.create" },
        { href: "/sessions", label: "POS sessions", perm: "session.open" },
        { href: "/tracking", label: "Tracking accounts", perm: "tracking_account.edit" },
      ],
    },
    {
      label: "Insights",
      items: [
        { href: "/reports", label: "Reports" },
        { href: "/alerts", label: "Alerts", perm: "alert.acknowledge" },
      ],
    },
    {
      label: "Administration",
      items: [
        { href: "/users", label: "Users", perm: "admin.user.manage" },
        { href: "/roles", label: "Roles", perm: "admin.role.manage" },
        { href: "/settings", label: "Business settings", perm: "admin.settings.manage" },
        { href: "/account", label: "Account" },
      ],
    },
  ];

  const perms = $derived(new Set(data.user.permissions ?? []));
  const nav = $derived(
    NAV.map((g) => ({
      ...g,
      items: g.items.filter(
        (n) => !n.perm || data.user.isRoot || perms.has(n.perm),
      ),
    })).filter((g) => g.items.length > 0),
  );

  const isActive = (href: string) =>
    page.url.pathname === href || page.url.pathname.startsWith(href + "/");
</script>

<div class="flex min-h-screen">
  <aside class="flex w-60 flex-col border-r bg-card">
    <a
      href="/"
      class="flex h-14 items-center gap-2.5 border-b px-5 font-semibold transition-colors hover:text-primary"
    >
      <img src="/logo.png" alt="Retale" class="h-7 w-auto" /> Console
    </a>
    <nav class="flex-1 overflow-y-auto p-3 pt-1">
      <div class="space-y-0.5 pt-2">
        <a
          href="/"
          class="block rounded-md px-3 py-2 text-sm transition-colors
            {isActive('/')
            ? 'bg-accent font-medium text-accent-foreground'
            : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'}"
        >
          Dashboard
        </a>
      </div>
      {#each nav as group (group.label)}
        <div
          class="px-3 pt-4 pb-1 text-xs font-medium tracking-wider text-muted-foreground uppercase"
        >
          {group.label}
        </div>
        <div class="space-y-0.5">
          {#each group.items as item (item.href)}
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
        </div>
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
