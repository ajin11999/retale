<script lang="ts">
  import { graphql } from "$houdini";
  import { goto } from "$app/navigation";
  import Button from "$lib/components/ui/button.svelte";
  import Combobox from "$lib/components/ui/combobox.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import { treePathMap } from "$lib/utils";
  import type { PageData } from "./$types";

  graphql(`
    query NewTransferLocations {
      locations {
        id
        name
        parentId
      }
    }
  `);

  const CreateTransfer = graphql(`
    mutation ConsoleCreateBlankTransfer(
      $targetLocationId: ID!
      $notes: String
    ) {
      createStockTransfer(
        targetLocationId: $targetLocationId
        notes: $notes
      ) {
        id
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const LocsData = $derived(data.NewTransferLocations);
  const locations = $derived($LocsData.data?.locations ?? []);

  const locationPaths = $derived(treePathMap(locations));
  const locationName = (id: string) => locationPaths.get(id) ?? "Unknown";

  const locationOptions = $derived(
    locations.map((l: any) => ({ value: l.id, label: locationName(l.id) })),
  );

  let targetLocationId = $state("");
  let notes = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function createDraft() {
    if (!targetLocationId) {
      error = "Pick a destination location.";
      return;
    }
    busy = true;
    error = null;
    try {
      const res = await CreateTransfer.mutate({
        targetLocationId,
        notes: notes.trim() || null,
      });
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      const id = res.data?.createStockTransfer.id;
      if (id) {
        await goto(`/transfers/${id}`);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>New transfer · Retale Console</title></svelte:head>

<div class="mx-auto max-w-xl space-y-4 pt-4">
  <div class="flex items-center justify-between">
    <h1 class="text-xl font-semibold">New transfer</h1>
    <Button variant="outline" size="sm" onclick={() => goto("/transfers")}>Cancel</Button>
  </div>

  {#if error}
    <p class="text-sm text-destructive">{error}</p>
  {/if}

  <div class="space-y-4 rounded-lg border bg-card p-5">
    <p class="text-sm text-muted-foreground">
      Create a blank draft transfer. You can add lines from multiple source locations on the next page.
    </p>

    <label class="block space-y-1">
      <span class="text-sm font-medium">Destination location</span>
      <Combobox
        options={locationOptions}
        bind:value={targetLocationId}
        placeholder="Search location…"
      />
    </label>

    <label class="block space-y-1">
      <span class="text-sm font-medium">Notes (optional)</span>
      <Input bind:value={notes} placeholder="e.g. Weekly restock" />
    </label>

    <div class="flex justify-end pt-2">
      <Button disabled={busy} onclick={createDraft}>
        Create draft
      </Button>
    </div>
  </div>
</div>
