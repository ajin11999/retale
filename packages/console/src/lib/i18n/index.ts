import en from "./packs/en.json";
import id from "./packs/id.json";

export type LocaleCode = "en" | "id";

export interface LocaleOption {
  code: LocaleCode;
  name: string;
  nativeName: string;
}

export const SUPPORTED_LOCALES: LocaleOption[] = [
  { code: "en", name: "English", nativeName: "English" },
  { code: "id", name: "Indonesian", nativeName: "Bahasa Indonesia" },
];

const PACKS: Record<LocaleCode, Record<string, string>> = {
  en,
  id,
};

class I18nManager {
  locale = $state<LocaleCode>("en");

  constructor() {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("retale_console_locale") as LocaleCode | null;
      if (saved && PACKS[saved]) {
        this.locale = saved;
      }
    }
  }

  setLocale(code: LocaleCode) {
    if (PACKS[code]) {
      this.locale = code;
      if (typeof window !== "undefined") {
        localStorage.setItem("retale_console_locale", code);
        document.cookie = `retale_console_locale=${code}; path=/; max-age=31536000; SameSite=Lax`;
      }
    }
  }

  t(key: string, params?: Record<string, string | number>): string {
    const pack = PACKS[this.locale] ?? PACKS.en;
    let text = pack[key] ?? PACKS.en[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
      }
    }
    return text;
  }
}

export const i18n = new I18nManager();
export const t = (key: string, params?: Record<string, string | number>) =>
  i18n.t(key, params);
