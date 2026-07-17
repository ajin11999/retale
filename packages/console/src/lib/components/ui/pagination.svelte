<script lang="ts">
  import { ChevronLeft, ChevronRight } from "@lucide/svelte";
  import Button from "./button.svelte";
  import { cn } from "$lib/utils";
  
  let {
    page = $bindable(1),
    pageSize = 50,
    totalItems = 0,
    class: className = "",
  }: {
    page: number;
    pageSize?: number;
    totalItems: number;
    class?: string;
  } = $props();

  const totalPages = $derived(Math.max(1, Math.ceil(totalItems / pageSize)));
</script>

{#if totalPages > 1}
  <div class={cn("flex items-center justify-between", className)}>
    <div class="text-sm text-muted-foreground">
      Showing {(page - 1) * pageSize + 1} to {Math.min(page * pageSize, totalItems)} of {totalItems} entries
    </div>
    <div class="flex items-center space-x-4">
      <Button
        variant="outline"
        size="sm"
        disabled={page <= 1}
        onclick={() => page -= 1}
      >
        <ChevronLeft class="h-4 w-4" />
        <span class="sr-only">Previous page</span>
      </Button>
      
      <div class="text-sm font-medium">
        Page {page} of {totalPages}
      </div>

      <Button
        variant="outline"
        size="sm"
        disabled={page >= totalPages}
        onclick={() => page += 1}
      >
        <ChevronRight class="h-4 w-4" />
        <span class="sr-only">Next page</span>
      </Button>
    </div>
  </div>
{/if}
