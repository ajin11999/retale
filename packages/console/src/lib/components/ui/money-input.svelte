<script lang="ts">
  import { tick } from "svelte";
  import type { HTMLInputAttributes } from "svelte/elements";
  import { cn } from "$lib/utils";

  // A money entry field for the literal rupiah value (DECIMAL(19,2) on the API).
  // Shows international grouping as you type — comma thousands, dot decimal —
  // while binding a plain number (e.g. 10.5), up to 2 decimal places. Use this
  // for every editable price/cost/amount so entry stays consistent with how
  // money renders elsewhere (formatMoney in $lib/utils).
  interface Props
    extends Omit<HTMLInputAttributes, "value" | "type" | "inputmode"> {
    /** The money value in rupiah (up to 2 decimals). `null` = empty. */
    value: number | null;
    /** Permit negative entry (e.g. signed ledger adjustments). */
    allowNegative?: boolean;
    /** Focus + select on mount, for inline / quick-edit use. */
    autofocus?: boolean;
    class?: string;
  }

  let {
    value = $bindable(),
    allowNegative = false,
    autofocus = false,
    class: className = "",
    ...rest
  }: Props = $props();

  let el = $state<HTMLInputElement | null>(null);

  /** Comma-group the integer part of a plain digit string. */
  const groupInt = (digits: string): string =>
    digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  /** A number → the displayed string: comma thousands, dot decimal, trimmed. */
  const fmt = (v: number | null): string =>
    v == null || Number.isNaN(v)
      ? ""
      : v.toLocaleString("en-US", { maximumFractionDigits: 2 });

  /**
   * Normalize a raw input string into the grouped display text and its numeric
   * value. Keeps at most one decimal point, caps the fraction to 2 digits, and
   * tolerates a lone "-" (negatives) / "10." (mid-entry) so typing flows.
   */
  function normalize(raw: string): { text: string; value: number | null } {
    const neg = allowNegative && raw.trimStart().startsWith("-");
    const s = raw.replace(/[^\d.]/g, "");
    const dot = s.indexOf(".");
    const hasDot = dot !== -1;
    let intPart = (hasDot ? s.slice(0, dot) : s).replace(/\./g, "");
    const frac = hasDot ? s.slice(dot + 1).replace(/\./g, "").slice(0, 2) : null;
    intPart = intPart.replace(/^0+(?=\d)/, ""); // drop leading zeros, keep a lone 0

    const sign = neg ? "-" : "";
    const groupedInt = intPart === "" ? "" : groupInt(intPart);
    const text =
      groupedInt === "" && frac == null
        ? sign // "" or a lone "-"
        : sign + (groupedInt === "" ? "0" : groupedInt) + (frac != null ? "." + frac : "");

    // Empty (no integer and no fraction digits) reads as null.
    const value =
      intPart === "" && (frac == null || frac === "")
        ? null
        : Number(sign + (intPart === "" ? "0" : intPart) + (frac ? "." + frac : ""));
    return { text, value: value != null && Number.isNaN(value) ? null : value };
  }

  import { evaluateMath } from "$lib/utils";

  let isEditingExpr = $state(false);

  /** The string the input shows, seeded from `value` and re-synced by the effect
   *  below when the value changes from outside (load / reset). */
  let text = $state(fmt(value));

  $effect(() => {
    // Don't fight mid-entry text (a trailing "." / "0" fmt would discard) — only
    // re-sync when the bound value disagrees with what the text parses to.
    if (!isEditingExpr && normalize(text).value !== value) text = fmt(value);
  });

  // Caret index just past the `keptLeft`-th significant char (digit or dot) of
  // `formatted`, so the cursor stays put as separators shift around it.
  function caretAfter(formatted: string, keptLeft: number, neg: boolean): number {
    if (keptLeft === 0) return neg && formatted.startsWith("-") ? 1 : 0;
    let seen = 0;
    for (let i = 0; i < formatted.length; i++) {
      const c = formatted.charCodeAt(i);
      const isSig = (c >= 48 && c <= 57) || c === 46; // digit or "."
      if (isSig && ++seen === keptLeft) return i + 1;
    }
    return formatted.length;
  }

  async function handleInput(e: Event) {
    const node = e.currentTarget as HTMLInputElement;
    const raw = node.value;

    const hasMath = /[+*/()]/.test(raw) || (allowNegative ? raw.lastIndexOf("-") > 0 : raw.includes("-"));
    if (hasMath) {
      isEditingExpr = true;
      const safe = raw.replace(/[^\d.+\-*/() ]/g, "");
      text = safe;
      node.value = safe;
      
      const evaled = evaluateMath(safe);
      if (evaled != null) {
        value = evaled;
      }
      (rest as any).oninput?.(e);
      return;
    }

    isEditingExpr = false;
    const caret = node.selectionStart ?? raw.length;
    const neg = allowNegative && raw.trimStart().startsWith("-");
    const keptLeft = (raw.slice(0, caret).match(/[\d.]/g) ?? []).length;

    const next = normalize(raw);
    value = next.value;
    text = next.text;
    node.value = next.text; // force, in case `text` itself didn't change

    await tick();
    if (el) {
      const pos = caretAfter(el.value, keptLeft, neg);
      el.setSelectionRange(pos, pos);
    }
    (rest as any).oninput?.(e);
  }

  function commitMath() {
    if (isEditingExpr) {
      const evaled = evaluateMath(text);
      if (evaled != null) {
        value = evaled;
      }
      isEditingExpr = false;
      text = fmt(value);
      if (el) el.value = text;
    }
  }

  function handleBlur(e: FocusEvent) {
    commitMath();
    (rest as any).onblur?.(e);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      commitMath();
    }
    (rest as any).onkeydown?.(e);
  }

  $effect(() => {
    if (autofocus && el) {
      el.focus();
      el.select();
    }
  });
</script>

<input
  bind:this={el}
  value={text}
  inputmode="decimal"
  class={cn(
    "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
    className,
  )}
  {...rest}
  oninput={handleInput}
  onblur={handleBlur}
  onkeydown={handleKeydown}
/>
