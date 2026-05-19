<script lang="ts">
  import { enhance } from "$app/forms";
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import type { ActionData } from "./$types";

  let { form }: { form: ActionData } = $props();
  let submitting = $state(false);
</script>

<svelte:head><title>Sign in · Retale Console</title></svelte:head>

<div class="flex min-h-screen items-center justify-center px-4">
  <div
    class="w-full max-w-sm rounded-lg border bg-card p-6 shadow-sm"
  >
    <h1 class="text-lg font-semibold">Retale Console</h1>
    <p class="mb-5 text-sm text-muted-foreground">
      Sign in to manage your store.
    </p>

    <form
      method="POST"
      use:enhance={() => {
        submitting = true;
        return async ({ update }) => {
          await update();
          submitting = false;
        };
      }}
      class="space-y-3"
    >
      <div class="space-y-1">
        <label for="username" class="text-sm font-medium">Username</label>
        <Input
          id="username"
          name="username"
          autocomplete="username"
          required
          value={form?.username ?? ""}
        />
      </div>
      <div class="space-y-1">
        <label for="password" class="text-sm font-medium">Password</label>
        <Input
          id="password"
          name="password"
          type="password"
          autocomplete="current-password"
          required
        />
      </div>

      {#if form?.message}
        <p class="text-sm text-destructive">{form.message}</p>
      {/if}

      <Button type="submit" class="w-full" disabled={submitting}>
        {submitting ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  </div>
</div>
