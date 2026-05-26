<script lang="ts">
  import type { Component } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";
  import { cn } from "$lib/utils";

  // Icon-only action button. `label` is required: it becomes both the tooltip
  // (title) and the accessible name (aria-label), since there's no visible text.
  let {
    icon: Icon,
    label,
    variant = "muted",
    class: className = "",
    ...rest
  }: HTMLButtonAttributes & {
    icon: Component<{ class?: string }>;
    label: string;
    variant?: "muted" | "primary" | "destructive";
  } = $props();

  const tone = {
    muted: "text-muted-foreground hover:text-foreground",
    primary: "text-primary hover:text-primary/80",
    destructive: "text-destructive hover:text-destructive/80",
  };
</script>

<button
  type="button"
  title={label}
  aria-label={label}
  class={cn(
    "inline-flex items-center justify-center rounded p-1 transition-colors disabled:cursor-not-allowed disabled:opacity-30",
    tone[variant],
    className,
  )}
  {...rest}
>
  <Icon class="size-4" />
</button>
