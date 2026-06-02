<script lang="ts">
  import { tick } from "svelte";
  import type { HTMLInputAttributes } from "svelte/elements";
  import { cn } from "$lib/utils";

  // A money entry field that shows id-ID thousand separators (dots) as you
  // type, while binding an integer **minor-unit** value (whole rupiah — see
  // formatMoney in $lib/utils). Display only; no decimals, since the minor
  // unit is the rupiah. Use this for every editable price/cost/amount so the
  // grouping is consistent with how money renders elsewhere.
  interface Props
    extends Omit<HTMLInputAttributes, "value" | "type" | "inputmode"> {
    /** Integer minor-unit value (whole rupiah). `null` = empty. */
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

  const fmt = (v: number | null): string =>
    v == null || Number.isNaN(v) ? "" : v.toLocaleString("id-ID");

  /** Parse a displayed string back to an integer, or null when empty. */
  function parse(s: string): number | null {
    const neg = allowNegative && s.trimStart().startsWith("-");
    const digits = s.replace(/\D/g, "");
    if (digits === "") return null;
    const n = Number(digits);
    return neg ? -n : n;
  }

  // The string the input shows. Seeded from the bound value and re-synced by
  // the effect below when the value is changed from outside (load / reset).
  let text = $state(fmt(value));

  $effect(() => {
    if (parse(text) !== value) text = fmt(value);
  });

  // Caret index just past the `digitsLeft`-th digit of `formatted`, so the
  // cursor stays put as separators shift around it.
  function caretAfter(
    formatted: string,
    digitsLeft: number,
    neg: boolean,
  ): number {
    if (digitsLeft === 0) return neg && formatted.startsWith("-") ? 1 : 0;
    let seen = 0;
    for (let i = 0; i < formatted.length; i++) {
      const c = formatted.charCodeAt(i);
      if (c >= 48 && c <= 57 && ++seen === digitsLeft) return i + 1;
    }
    return formatted.length;
  }

  async function handleInput(e: Event) {
    const node = e.currentTarget as HTMLInputElement;
    const raw = node.value;
    const caret = node.selectionStart ?? raw.length;
    const neg = allowNegative && raw.trimStart().startsWith("-");
    const digitsLeft = raw.slice(0, caret).replace(/\D/g, "").length;

    const next = parse(raw);
    value = next;
    // Keep a lone "-" visible so a negative can still be entered.
    const grouped = next == null ? (neg ? "-" : "") : fmt(next);
    text = grouped;
    node.value = grouped; // force, in case `text` itself didn't change

    await tick();
    if (el) {
      const pos = caretAfter(el.value, digitsLeft, neg);
      el.setSelectionRange(pos, pos);
    }
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
  inputmode="numeric"
  class={cn(
    "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
    className,
  )}
  {...rest}
  oninput={handleInput}
/>
