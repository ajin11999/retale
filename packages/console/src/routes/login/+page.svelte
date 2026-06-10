<script lang="ts">
  import { enhance } from "$app/forms";
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import type { ActionData } from "./$types";

  let { form }: { form: ActionData } = $props();
  let submitting = $state(false);

  // ActionData is a union across both actions and their failure shapes — read
  // each field through an `in` guard so the narrowing holds.
  const twoFactor = $derived(
    form && "step" in form && form.step === "twoFactor"
      ? { challengeToken: form.challengeToken, username: form.username }
      : null,
  );
  const message = $derived(form && "message" in form ? form.message : null);
  const username = $derived(form && "username" in form ? form.username : "");

  const onsubmit = () => {
    submitting = true;
    return async ({ update }: { update: () => Promise<void> }) => {
      await update();
      submitting = false;
    };
  };
</script>

<svelte:head><title>Sign in · Retale Console</title></svelte:head>

<div class="flex min-h-screen items-center justify-center px-4">
  <div class="w-full max-w-sm rounded-lg border bg-card p-6 shadow-sm">
    <div class="mb-5 flex items-center gap-2.5">
      <img src="/logo.png" alt="Retale" class="h-8 w-auto" />
    </div>

    {#if twoFactor}
      <!-- Step 2 — two-factor code -->
      <p class="mb-5 text-sm text-muted-foreground">
        Signing in as <span class="font-medium text-foreground"
          >{twoFactor.username}</span
        >. Enter your authentication code.
      </p>

      <form method="POST" action="?/twoFactor" use:enhance={onsubmit} class="space-y-3">
        <input type="hidden" name="challengeToken" value={twoFactor.challengeToken} />
        <input type="hidden" name="username" value={twoFactor.username} />

        <div class="space-y-1">
          <label for="code" class="text-sm font-medium">Authentication code</label>
          <Input
            id="code"
            name="code"
            inputmode="numeric"
            autocomplete="one-time-code"
            placeholder="123456"
            required
          />
          <p class="text-xs text-muted-foreground">
            6-digit code from your authenticator app, or a recovery code.
          </p>
        </div>

        {#if message}
          <p class="text-sm text-destructive">{message}</p>
        {/if}

        <Button type="submit" class="w-full" disabled={submitting}>
          {submitting ? "Verifying…" : "Verify"}
        </Button>
      </form>

      <button
        class="mt-3 text-sm text-muted-foreground hover:text-foreground"
        onclick={() => (form = null)}
      >
        ← Use a different account
      </button>
    {:else}
      <!-- Step 1 — username + password -->
      <p class="mb-5 text-sm text-muted-foreground">
        Sign in to manage your store.
      </p>

      <form method="POST" action="?/password" use:enhance={onsubmit} class="space-y-3">
        <div class="space-y-1">
          <label for="username" class="text-sm font-medium">Username</label>
          <Input
            id="username"
            name="username"
            autocomplete="username"
            required
            value={username}
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

        {#if message}
          <p class="text-sm text-destructive">{message}</p>
        {/if}

        <Button type="submit" class="w-full" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    {/if}
  </div>
</div>
