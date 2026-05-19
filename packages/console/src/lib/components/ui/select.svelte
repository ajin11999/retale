<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLSelectAttributes } from "svelte/elements";
  import { cn } from "$lib/utils";

  let {
    class: className = "",
    value = $bindable(),
    children,
    ...rest
  }: HTMLSelectAttributes & { children: Snippet } = $props();
</script>

<select
  bind:value
  class={cn(
    "flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
    className,
  )}
  {...rest}
>
  {@render children()}
</select>
