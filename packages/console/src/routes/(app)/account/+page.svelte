<script lang="ts">
  import { graphql } from "$houdini";
  import QRCode from "qrcode";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import LanguagePreference from "$lib/components/ui/language-preference.svelte";
  import { t } from "$lib/i18n";
  import type { PageData } from "./$types";

  graphql(`
    query AccountMe {
      me {
        id
        username
        name
        isRoot
        twoFactorEnabled
      }
    }
  `);

  const SetupTwoFactor = graphql(`
    mutation ConsoleSetupTwoFactor {
      setupTwoFactor {
        otpauthUrl
        secret
        recoveryCodes
      }
    }
  `);

  const ConfirmTwoFactor = graphql(`
    mutation ConsoleConfirmTwoFactor($code: String!) {
      confirmTwoFactor(code: $code)
    }
  `);

  const DisableTwoFactor = graphql(`
    mutation ConsoleDisableTwoFactor {
      disableTwoFactor
    }
  `);

  const RegenerateRecoveryCodes = graphql(`
    mutation ConsoleRegenerateRecoveryCodes {
      regenerateRecoveryCodes
    }
  `);

  let { data }: { data: PageData } = $props();
  const AccountMe = $derived(data.AccountMe);
  const me = $derived($AccountMe.data?.me ?? null);

  // ---- Enrolment flow ------------------------------------------------------
  // pending: the secret + recovery codes returned by setupTwoFactor, kept
  // in memory only until the user confirms (or cancels). The recovery codes
  // are shown exactly once — the server will not return them again.
  type Pending = {
    otpauthUrl: string;
    secret: string;
    recoveryCodes: string[];
  };
  let pending = $state<Pending | null>(null);
  let confirmCode = $state("");

  // QR data-URL for the pending otpauth URL, regenerated whenever it changes.
  let qrDataUrl = $state<string | null>(null);
  $effect(() => {
    const url = pending?.otpauthUrl;
    if (!url) {
      qrDataUrl = null;
      return;
    }
    QRCode.toDataURL(url, { width: 220, margin: 2, errorCorrectionLevel: "M" })
      .then((d) => (qrDataUrl = d))
      .catch(() => (qrDataUrl = null));
  });

  // freshCodes: the new recovery codes returned by regenerateRecoveryCodes —
  // shown until the user dismisses the panel.
  let freshCodes = $state<string[] | null>(null);

  let busy = $state(false);
  let error = $state<string | null>(null);
  let info = $state<string | null>(null);

  async function startSetup() {
    busy = true;
    error = null;
    info = null;
    try {
      const res = await SetupTwoFactor.mutate(null);
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      const r = res.data?.setupTwoFactor;
      if (r) pending = { ...r };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function confirmSetup() {
    const code = confirmCode.replace(/[\s-]/g, "").trim();
    if (!pending || !code) return;
    busy = true;
    error = null;
    try {
      const res = await ConfirmTwoFactor.mutate({ code });
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      pending = null;
      confirmCode = "";
      info = t("account.twoFactorEnabledMsg");
      await AccountMe.fetch();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function disable() {
    if (!confirm(t("account.confirmDisable"))) return;
    busy = true;
    error = null;
    try {
      const res = await DisableTwoFactor.mutate(null);
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      info = t("account.twoFactorDisabledMsg");
      await AccountMe.fetch();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function regenerate() {
    if (
      !confirm(
        t("account.confirmRegenerate"),
      )
    ) {
      return;
    }
    busy = true;
    error = null;
    try {
      const res = await RegenerateRecoveryCodes.mutate(null);
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      freshCodes = res.data?.regenerateRecoveryCodes ?? [];
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      info = t("account.copiedToClipboard");
    } catch {
      error = t("account.copyFailed");
    }
  }
</script>

<svelte:head><title>{t("account.title")} · Retale Console</title></svelte:head>

<div class="max-w-2xl space-y-6">
  <div>
    <h1 class="text-xl font-semibold">{t("account.title")}</h1>
    <p class="text-sm text-muted-foreground">
      {t("account.subtitle")}
    </p>
  </div>

  <LanguagePreference />

  {#if error}
    <p class="text-sm text-destructive">{error}</p>
  {/if}
  {#if info}
    <p class="text-sm text-emerald-700">{info}</p>
  {/if}

  {#if $AccountMe.fetching && !me}
    <p class="text-sm text-muted-foreground">{t("common.loading")}</p>
  {:else if !me}
    <p class="text-sm text-destructive">{t("account.notSignedIn")}</p>
  {:else}
    <!-- Identity -->
    <section class="rounded-lg border bg-card p-4">
      <h2 class="mb-2 text-sm font-semibold">{t("account.profile")}</h2>
      <dl class="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
        <dt class="text-muted-foreground">{t("account.name")}</dt>
        <dd>{me.name}</dd>
        <dt class="text-muted-foreground">{t("account.username")}</dt>
        <dd class="font-mono text-xs">{me.username}</dd>
        <dt class="text-muted-foreground">{t("account.role")}</dt>
        <dd>
          {#if me.isRoot}
            <Badge class="bg-primary/10 text-primary">{t("users.root")}</Badge>
          {:else}
            <span class="text-muted-foreground">{t("account.standard")}</span>
          {/if}
        </dd>
      </dl>
    </section>

    <!-- 2FA -->
    <section class="space-y-3 rounded-lg border bg-card p-4">
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold">{t("account.twoFactor")}</h2>
        {#if me.twoFactorEnabled}
          <Badge class="bg-emerald-100 text-emerald-700">{t("account.enabled")}</Badge>
        {:else}
          <Badge class="bg-muted text-muted-foreground">{t("account.disabled")}</Badge>
        {/if}
      </div>

      {#if me.isRoot && !me.twoFactorEnabled && !pending}
        <div class="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <p class="font-medium">{t("account.rootEnrollTitle")}</p>
          <p class="mt-0.5 text-xs text-amber-800">
            {t("account.rootEnrollDesc")}
          </p>
        </div>
      {/if}

      {#if pending}
        <!-- Enrolment in progress -->
        <p class="text-sm text-muted-foreground">
          {t("account.scanQrHint")}
        </p>

        {#if qrDataUrl}
          <div class="flex justify-center">
            <img
              src={qrDataUrl}
              alt={t("account.qrAlt")}
              width="220"
              height="220"
              class="rounded-md border bg-white p-2"
            />
          </div>
        {/if}

        <details class="text-sm">
          <summary class="cursor-pointer text-xs text-muted-foreground">
            {t("account.cantScan")}
          </summary>
          <div class="mt-2 space-y-2 rounded-md border bg-muted/40 p-3 text-sm">
          <div>
            <p class="text-xs text-muted-foreground">{t("account.otpauthUrl")}</p>
            <div class="flex items-start gap-2">
              <code class="flex-1 break-all rounded bg-background px-2 py-1 text-xs">
                {pending.otpauthUrl}
              </code>
              <Button
                size="sm"
                variant="outline"
                onclick={() => copy(pending!.otpauthUrl)}>{t("common.copy")}</Button
              >
            </div>
          </div>
          <div>
            <p class="text-xs text-muted-foreground">{t("account.secret")}</p>
            <div class="flex items-center gap-2">
              <code class="rounded bg-background px-2 py-1 font-mono text-sm">
                {pending.secret}
              </code>
              <Button
                size="sm"
                variant="outline"
                onclick={() => copy(pending!.secret)}>{t("common.copy")}</Button
              >
            </div>
          </div>
          </div>
        </details>

        <div>
          <p class="mb-1 text-sm font-medium">{t("account.recoveryCodes")}</p>
          <p class="mb-2 text-xs text-muted-foreground">
            {t("account.recoveryCodesHint")}
          </p>
          <div class="grid grid-cols-2 gap-1 rounded-md border bg-muted/40 p-3">
            {#each pending.recoveryCodes as c (c)}
              <code class="font-mono text-xs">{c}</code>
            {/each}
          </div>
          <Button
            size="sm"
            variant="outline"
            class="mt-2"
            onclick={() => copy(pending!.recoveryCodes.join("\n"))}
          >
            {t("common.copyAll")}
          </Button>
        </div>

        <div class="flex items-end gap-2 border-t pt-3">
          <label class="flex-1 space-y-1">
            <span class="text-sm font-medium">{t("account.enterCode")}</span>
            <Input
              bind:value={confirmCode}
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength={8}
            />
          </label>
          <Button
            size="sm"
            disabled={busy || !confirmCode.trim()}
            onclick={confirmSetup}>{t("account.confirmEnable")}</Button
          >
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onclick={() => {
              pending = null;
              confirmCode = "";
            }}>{t("common.cancel")}</Button
          >
        </div>
      {:else if me.twoFactorEnabled}
        {#if freshCodes}
          <div class="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
            <p class="mb-1 font-medium text-amber-900">
              {t("account.newRecoveryCodes")}
            </p>
            <div class="grid grid-cols-2 gap-1 rounded bg-background p-2">
              {#each freshCodes as c (c)}
                <code class="font-mono text-xs">{c}</code>
              {/each}
            </div>
            <div class="mt-2 flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onclick={() => copy(freshCodes!.join("\n"))}>{t("common.copyAll")}</Button
              >
              <Button size="sm" variant="ghost" onclick={() => (freshCodes = null)}>
                {t("common.dismiss")}
              </Button>
            </div>
          </div>
        {/if}

        <p class="text-sm text-muted-foreground">
          {t("account.signInRequiresCode")}
        </p>
        <div class="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onclick={regenerate}>{t("account.regenerateCodes")}</Button
          >
          <Button
            size="sm"
            variant="destructive"
            disabled={busy}
            onclick={disable}>{t("account.disable2fa")}</Button
          >
        </div>
      {:else}
        <p class="text-sm text-muted-foreground">
          {t("account.addSecondFactorHint")}
        </p>
        <Button size="sm" disabled={busy} onclick={startSetup}>
          {t("account.enable2fa")}
        </Button>
      {/if}
    </section>
  {/if}
</div>
