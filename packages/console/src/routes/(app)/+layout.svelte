<script lang="ts">
  import { page } from "$app/state";
  import type { Snippet, Component } from "svelte";
  import { t } from "$lib/i18n";
  import type { LayoutServerData } from "./$types";
  import {
    LayoutDashboard,
    Package,
    Layers,
    FolderTree,
    GitCompare,
    Globe,
    Boxes,
    SlidersHorizontal,
    ArrowLeftRight,
    Warehouse,
    ShoppingCart,
    FileText,
    RefreshCw,
    ClipboardList,
    Send,
    Truck,
    Building2,
    Store,
    Receipt,
    Users,
    Monitor,
    History,
    Tag,
    BarChart3,
    Bell,
    Shield,
    ShieldCheck,
    Settings,
    User,
    ChevronDown,
    ChevronRight,
    LogOut,
  } from "@lucide/svelte";

  let {
    data,
    children,
  }: { data: LayoutServerData; children: Snippet } = $props();

  // `perm` gates a link on a viewer permission; omit it to always show. Root
  // bypasses the check (permissions resolves to the full catalog for root).
  interface NavItem {
    href: string;
    labelKey: string;
    perm?: string;
    icon: Component;
  }
  interface NavGroup {
    id: string;
    labelKey: string;
    icon: Component;
    items: NavItem[];
  }

  const NAV: NavGroup[] = [
    {
      id: "catalog",
      labelKey: "nav.catalog",
      icon: Package,
      items: [
        { href: "/products", labelKey: "nav.products", icon: Layers },
        { href: "/categories", labelKey: "nav.categories", icon: FolderTree },
        { href: "/interchange-groups", labelKey: "nav.interchangeGroups", icon: GitCompare },
        { href: "/catalog", labelKey: "nav.onlineCatalog", perm: "catalog.manage", icon: Globe },
      ],
    },
    {
      id: "inventory",
      labelKey: "nav.inventory",
      icon: Boxes,
      items: [
        { href: "/stock", labelKey: "nav.stock", icon: SlidersHorizontal },
        { href: "/transfers", labelKey: "nav.transfers", icon: ArrowLeftRight },
        { href: "/locations", labelKey: "nav.locations", icon: Warehouse },
      ],
    },
    {
      id: "purchasing",
      labelKey: "nav.purchasing",
      icon: ShoppingCart,
      items: [
        { href: "/purchases", labelKey: "nav.purchases", icon: FileText },
        { href: "/reorder", labelKey: "nav.reorder", icon: RefreshCw },
        { href: "/requisitions", labelKey: "nav.requisitions", icon: ClipboardList },
        { href: "/rfqs", labelKey: "nav.rfqs", icon: Send },
        { href: "/deliveries", labelKey: "nav.deliveries", perm: "delivery.draft", icon: Truck },
        { href: "/vendors", labelKey: "nav.vendors", icon: Building2 },
      ],
    },
    {
      id: "sales",
      labelKey: "nav.sales",
      icon: Store,
      items: [
        { href: "/orders", labelKey: "nav.orders", perm: "report.sales.view", icon: Receipt },
        { href: "/customers", labelKey: "nav.customers", icon: Users },
        { href: "/registers", labelKey: "nav.registers", perm: "pos.create", icon: Monitor },
        { href: "/sessions", labelKey: "nav.sessions", perm: "session.open", icon: History },
        { href: "/tracking", labelKey: "nav.tracking", perm: "tracking_account.edit", icon: Tag },
      ],
    },
    {
      id: "insights",
      labelKey: "nav.insights",
      icon: BarChart3,
      items: [
        { href: "/reports", labelKey: "nav.reports", icon: BarChart3 },
        { href: "/alerts", labelKey: "nav.alerts", perm: "alert.acknowledge", icon: Bell },
      ],
    },
    {
      id: "admin",
      labelKey: "nav.administration",
      icon: ShieldCheck,
      items: [
        { href: "/users", labelKey: "nav.users", perm: "admin.user.manage", icon: Users },
        { href: "/roles", labelKey: "nav.roles", perm: "admin.role.manage", icon: Shield },
        { href: "/settings", labelKey: "nav.businessSettings", perm: "admin.settings.manage", icon: Settings },
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

  const isActive = (href: string) => {
    if (href === "/") return page.url.pathname === "/";
    return page.url.pathname === href || page.url.pathname.startsWith(href + "/");
  };

  const isGroupActive = (group: { items: NavItem[] }) =>
    group.items.some((item) => isActive(item.href));

  // Accordion state: map of groupId -> open boolean
  let openGroups = $state<Record<string, boolean>>({});

  // Auto-expand group that contains the current active route
  $effect(() => {
    const currentPath = page.url.pathname;
    for (const group of nav) {
      if (group.items.some((item) => isActive(item.href))) {
        openGroups[group.id] = true;
      }
    }
  });

  const toggleGroup = (groupId: string) => {
    openGroups[groupId] = !openGroups[groupId];
  };
</script>

<div class="flex min-h-screen">
  <aside class="flex w-64 flex-col border-r bg-card print:hidden select-none">
    <!-- Brand Header -->
    <a
      href="/"
      class="flex h-14 items-center gap-2.5 border-b px-4 font-semibold tracking-tight transition-colors hover:text-primary"
    >
      <img src="/logo.png" alt="Retale" class="h-6 w-auto" />
      <span class="font-bold text-base">Retale</span>
      <span class="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary uppercase tracking-wider">Console</span>
    </a>

    <!-- Main Navigation Area -->
    <nav class="flex-1 overflow-y-auto px-2.5 py-2 space-y-1">
      <!-- Dashboard Top Link -->
      <a
        href="/"
        class="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-xs font-medium transition-colors
          {isActive('/')
          ? 'bg-primary text-primary-foreground shadow-xs'
          : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'}"
      >
        <LayoutDashboard class="h-4 w-4 shrink-0" />
        <span class="truncate">{t("nav.dashboard")}</span>
      </a>

      <div class="my-1.5 border-t border-border/50"></div>

      <!-- Accordion Navigation Groups -->
      {#each nav as group (group.id)}
        {@const isOpen = !!openGroups[group.id]}
        {@const hasActiveChild = isGroupActive(group)}
        {@const GroupIcon = group.icon}

        <div class="space-y-0.5">
          <!-- Group Accordion Header Button -->
          <button
            type="button"
            onclick={() => toggleGroup(group.id)}
            class="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-xs font-semibold tracking-wide transition-colors cursor-pointer
              {hasActiveChild && !isOpen
              ? 'text-primary bg-primary/5 hover:bg-primary/10'
              : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'}"
          >
            <div class="flex items-center gap-2 truncate">
              <GroupIcon class="h-3.5 w-3.5 shrink-0 {hasActiveChild ? 'text-primary' : 'text-muted-foreground'}" />
              <span class="truncate uppercase tracking-wider text-[11px]">{t(group.labelKey)}</span>
            </div>

            <div class="flex items-center gap-1.5">
              {#if hasActiveChild && !isOpen}
                <span class="h-1.5 w-1.5 rounded-full bg-primary"></span>
              {/if}
              {#if isOpen}
                <ChevronDown class="h-3.5 w-3.5 text-muted-foreground transition-transform" />
              {:else}
                <ChevronRight class="h-3.5 w-3.5 text-muted-foreground transition-transform" />
              {/if}
            </div>
          </button>

          <!-- Group Sub-items List (Collapsible) -->
          {#if isOpen}
            <div class="ml-3 pl-2.5 border-l border-border/60 space-y-0.5 py-0.5">
              {#each group.items as item (item.href)}
                {@const itemActive = isActive(item.href)}
                {@const ItemIcon = item.icon}
                <a
                  href={item.href}
                  class="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium transition-colors
                    {itemActive
                    ? 'bg-accent text-accent-foreground font-semibold shadow-2xs'
                    : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'}"
                >
                  <ItemIcon class="h-3.5 w-3.5 shrink-0 {itemActive ? 'text-primary' : 'text-muted-foreground/70'}" />
                  <span class="truncate">{t(item.labelKey)}</span>
                </a>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    </nav>

    <!-- User Profile & System Footer -->
    <div class="border-t bg-card/60 p-2.5 space-y-2">
      <div class="flex items-center justify-between gap-2 rounded-lg bg-secondary/60 p-2">
        <div class="flex items-center gap-2 min-w-0">
          <div class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-semibold">
            {data.user.name.slice(0, 1).toUpperCase()}
          </div>
          <div class="min-w-0 flex-1">
            <div class="truncate text-xs font-medium text-foreground">
              {data.user.name}
            </div>
            <div class="flex items-center gap-1 text-[10px] text-muted-foreground">
              {#if data.user.isRoot}
                <span class="rounded bg-primary/15 px-1 py-0.2 text-[9px] font-semibold text-primary">root</span>
              {/if}
              <span class="truncate">@{data.user.username}</span>
            </div>
          </div>
        </div>

        <div class="flex items-center gap-1 shrink-0">
          <a
            href="/account"
            title={t("nav.account")}
            class="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            <User class="h-3.5 w-3.5" />
          </a>
          <form method="POST" action="/logout">
            <button
              type="submit"
              title={t("common.signOut")}
              class="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors cursor-pointer"
            >
              <LogOut class="h-3.5 w-3.5" />
            </button>
          </form>
        </div>
      </div>
    </div>
  </aside>

  <div class="flex flex-1 flex-col min-w-0">
    <header
      class="flex h-14 items-center justify-between border-b bg-card px-6 print:hidden"
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
      <div class="flex items-center gap-3">
        <a
          href="/account"
          class="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {t("nav.account")}
        </a>
        <span class="text-border">|</span>
        <form method="POST" action="/logout">
          <button
            type="submit"
            class="text-xs text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
          >
            {t("common.signOut")}
          </button>
        </form>
      </div>
    </header>

    <main class="flex-1 p-6 print:p-0">
      {#if data.user.isRoot && !data.user.twoFactorEnabled && page.url.pathname !== "/account"}
        <div
          class="mb-6 flex items-center justify-between gap-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          <div>
            <span class="font-semibold">Two-factor authentication required:</span>
            <span>
              Root users must enroll in 2FA before store operations can be performed.
            </span>
          </div>
          <a
            href="/account"
            class="whitespace-nowrap rounded bg-amber-200 px-3 py-1.5 text-xs font-semibold text-amber-900 transition-colors hover:bg-amber-300"
          >
            Enable 2FA &rarr;
          </a>
        </div>
      {/if}
      {@render children()}
    </main>
  </div>
</div>
