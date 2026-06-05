<script lang="ts">
  import type { HTMLInputAttributes } from "svelte/elements";
  import { cn } from "$lib/utils";

  let {
    class: className = "",
    value = $bindable(),
    ref = $bindable<HTMLInputElement | null>(null),
    ...rest
  }: HTMLInputAttributes & { ref?: HTMLInputElement | null } = $props();
</script>

<input
  bind:this={ref}
  bind:value
  class={cn(
    "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
    className,
  )}
  {...rest}
/>
