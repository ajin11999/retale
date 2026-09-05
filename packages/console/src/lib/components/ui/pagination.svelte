<script lang="ts">
  import { ChevronLeft, ChevronRight } from "@lucide/svelte";
  import Button from "./button.svelte";
  import { cn } from "$lib/utils";
  import { t } from "$lib/i18n";
  
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
      {t("common.showing", { from: (page - 1) * pageSize + 1, to: Math.min(page * pageSize, totalItems), total: totalItems })}
    </div>
    <div class="flex items-center space-x-4">
      <Button
        variant="outline"
        size="sm"
        disabled={page <= 1}
        onclick={() => page -= 1}
      >
        <ChevronLeft class="h-4 w-4" />
        <span class="sr-only">{t("common.previousPage")}</span>
      </Button>
      
      <div class="text-sm font-medium">
        {t("common.page", { current: page, total: totalPages })}
      </div>

      <Button
        variant="outline"
        size="sm"
        disabled={page >= totalPages}
        onclick={() => page += 1}
      >
        <ChevronRight class="h-4 w-4" />
        <span class="sr-only">{t("common.nextPage")}</span>
      </Button>
    </div>
  </div>
{/if}
