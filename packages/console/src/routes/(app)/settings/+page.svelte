<script lang="ts">
  import { CachePolicy, graphql } from "$houdini";
  import { page } from "$app/state";
  import type { Viewer } from "../+layout.server";
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import Textarea from "$lib/components/ui/textarea.svelte";
  import type { PageData } from "./$types";

  graphql(`
    query BusinessSettingsView {
      businessSettings {
        name
        phone
        email
        logoUrl
        poGreeting
        poFooter
        updatedAt
      }
    }
  `);

  const ClearBusinessLogo = graphql(`
    mutation ConsoleClearBusinessLogo {
      clearBusinessLogo {
        logoUrl
        updatedAt
      }
    }
  `);

  const UpdateBusinessSettings = graphql(`
    mutation ConsoleUpdateBusinessSettings(
      $name: String
      $phone: String
      $email: String
      $poGreeting: String
      $poFooter: String
    ) {
      updateBusinessSettings(
        name: $name
        phone: $phone
        email: $email
        poGreeting: $poGreeting
        poFooter: $poFooter
      ) {
        name
        phone
        email
        poGreeting
        poFooter
        updatedAt
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const View = $derived(data.BusinessSettingsView);
  const settings = $derived($View.data?.businessSettings ?? null);

  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canManage = $derived(has("admin.settings.manage"));

  // Working draft — initialised from the server value, reset on every load.
  let name = $state("");
  let phone = $state("");
  let email = $state("");
  let poGreeting = $state("");
  let poFooter = $state("");
  let loadedFor = $state<string | null>(null);

  $effect(() => {
    // Re-seed the form when the underlying record changes (initial load,
    // post-save refetch). Comparing updatedAt is enough: any successful
    // save bumps it.
    const key = settings?.updatedAt ?? "";
    if (settings && key !== loadedFor) {
      name = settings.name ?? "";
      phone = settings.phone ?? "";
      email = settings.email ?? "";
      poGreeting = settings.poGreeting ?? "";
      poFooter = settings.poFooter ?? "";
      loadedFor = key;
    }
  });

  let busy = $state(false);
  let error = $state<string | null>(null);
  let info = $state<string | null>(null);

  // Pass empty strings through verbatim — the API treats them as "clear this
  // optional field." Required `name` is rejected by the server if blank.
  async function save() {
    busy = true;
    error = null;
    info = null;
    try {
      const res = await UpdateBusinessSettings.mutate({
        name: name.trim(),
        phone: phone.trim(),
        email: email.trim(),
        poGreeting,
        poFooter,
      });
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      info = "Settings saved.";
      await View.fetch({ policy: CachePolicy.NetworkOnly });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  // ---- Logo upload / remove ------------------------------------------------
  let logoBusy = $state(false);
  let fileInput = $state<HTMLInputElement | null>(null);

  async function uploadLogo(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    logoBusy = true;
    error = null;
    info = null;
    try {
      const body = new FormData();
      body.append("file", file, file.name);
      const res = await fetch("/settings/logo", { method: "POST", body });
      if (!res.ok) {
        const msg = await res.text();
        error = msg || `Upload failed (${res.status})`;
        return;
      }
      info = "Logo updated.";
      await View.fetch({ policy: CachePolicy.NetworkOnly });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      logoBusy = false;
      if (fileInput) fileInput.value = "";
    }
  }

  async function removeLogo() {
    if (!confirm("Remove the business logo?")) return;
    logoBusy = true;
    error = null;
    info = null;
    try {
      const res = await ClearBusinessLogo.mutate(null);
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      info = "Logo removed.";
      await View.fetch({ policy: CachePolicy.NetworkOnly });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      logoBusy = false;
    }
  }

  const fmtDateTime = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleString("id-ID") : "—";
</script>

<svelte:head><title>Business settings · Retale Console</title></svelte:head>

<div class="max-w-2xl space-y-4">
  <div>
    <h1 class="text-xl font-semibold">Business settings</h1>
    <p class="text-sm text-muted-foreground">
      Used on purchase orders and receipts.
    </p>
  </div>

  {#if error}
    <p class="text-sm text-destructive">{error}</p>
  {/if}
  {#if info}
    <p class="text-sm text-emerald-700">{info}</p>
  {/if}

  {#if $View.fetching && !settings}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if $View.errors?.length}
    <p class="text-sm text-destructive">{$View.errors[0].message}</p>
  {:else if !settings}
    <p class="text-sm text-muted-foreground">No settings record.</p>
  {:else}
    <a
      href="/settings/addresses"
      class="flex items-center justify-between rounded-lg border bg-card p-4 hover:bg-accent"
    >
      <div>
        <h2 class="text-sm font-semibold">Ship-to addresses</h2>
        <p class="text-xs text-muted-foreground">
          Your locations, printed as “Ship To” on purchase orders.
        </p>
      </div>
      <span class="text-muted-foreground">→</span>
    </a>

    <section class="space-y-3 rounded-lg border bg-card p-4">
      <h2 class="text-sm font-semibold">Identity</h2>
      <label class="block space-y-1">
        <span class="text-sm font-medium">Business name</span>
        <Input bind:value={name} disabled={!canManage} />
      </label>
      <div class="grid grid-cols-2 gap-3">
        <label class="space-y-1">
          <span class="text-sm font-medium">Phone</span>
          <Input bind:value={phone} disabled={!canManage} />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Email</span>
          <Input bind:value={email} disabled={!canManage} />
        </label>
      </div>

      <div class="space-y-2">
        <span class="text-sm font-medium">Logo</span>
        <p class="text-xs text-muted-foreground">
          Shown on purchase orders. PNG or JPG; transparent PNG looks best.
        </p>
        <div class="flex items-center gap-4">
          <div
            class="flex h-20 w-32 items-center justify-center rounded-md border bg-muted/30"
          >
            {#if settings.logoUrl}
              <img
                src={settings.logoUrl}
                alt="Business logo"
                class="max-h-full max-w-full object-contain"
              />
            {:else}
              <span class="text-xs text-muted-foreground">No logo</span>
            {/if}
          </div>
          <div class="flex flex-col gap-2">
            <input
              bind:this={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={!canManage || logoBusy}
              onchange={uploadLogo}
              class="text-sm"
            />
            {#if settings.logoUrl}
              <Button
                variant="outline"
                size="sm"
                disabled={!canManage || logoBusy}
                onclick={removeLogo}>Remove logo</Button
              >
            {/if}
          </div>
        </div>
      </div>
    </section>

    <section class="space-y-3 rounded-lg border bg-card p-4">
      <div>
        <h2 class="text-sm font-semibold">Purchase order template</h2>
        <p class="text-xs text-muted-foreground">
          Wrapped around the auto-generated PO line items in WhatsApp / email
          messages.
        </p>
      </div>
      <label class="block space-y-1">
        <span class="text-sm font-medium">Greeting</span>
        <Textarea
          bind:value={poGreeting}
          disabled={!canManage}
          placeholder="e.g. Hi {'{vendor}'}, please prepare the following:"
          class="min-h-16"
        />
      </label>
      <label class="block space-y-1">
        <span class="text-sm font-medium">Footer</span>
        <Textarea
          bind:value={poFooter}
          disabled={!canManage}
          placeholder="e.g. Thanks! — {'{business}'}"
          class="min-h-16"
        />
      </label>
    </section>

    <div class="flex items-center justify-between">
      <p class="text-xs text-muted-foreground">
        Last updated {fmtDateTime(settings.updatedAt)}
      </p>
      <Button
        size="sm"
        disabled={busy || !canManage || !name.trim()}
        onclick={save}>Save changes</Button
      >
    </div>

    {#if !canManage}
      <p class="text-sm text-muted-foreground">
        You don't have permission to edit these settings.
      </p>
    {/if}
  {/if}
</div>
