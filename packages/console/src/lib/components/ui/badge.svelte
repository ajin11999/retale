<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils";

  let {
    class: className = "",
    children,
  }: { class?: string; children: Snippet } = $props();
</script>

<span
  class={cn(
    "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
    className,
  )}
>
  {@render children()}
</span>
