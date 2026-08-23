<script lang="ts">
  import { i18n, t, SUPPORTED_LOCALES, type LocaleCode } from "$lib/i18n";
  import Select from "$lib/components/ui/select.svelte";

  let currentLocale = $state<LocaleCode>(i18n.locale);

  $effect(() => {
    currentLocale = i18n.locale;
  });

  function onChange(e: Event) {
    const target = e.target as HTMLSelectElement;
    const val = target.value as LocaleCode;
    i18n.setLocale(val);
  }
</script>

<section class="space-y-3 rounded-lg border bg-card p-4">
  <div>
    <h2 class="text-sm font-semibold">{t("settings.languageSection")}</h2>
    <p class="text-xs text-muted-foreground">
      {t("settings.languageSubtitle")}
    </p>
  </div>
  <div class="max-w-xs space-y-1">
    <label for="language-select" class="text-sm font-medium">
      {t("settings.displayLanguage")}
    </label>
    <Select id="language-select" value={currentLocale} onchange={onChange}>
      {#each SUPPORTED_LOCALES as loc (loc.code)}
        <option value={loc.code}>
          {loc.nativeName} ({loc.name})
        </option>
      {/each}
    </Select>
  </div>
</section>
