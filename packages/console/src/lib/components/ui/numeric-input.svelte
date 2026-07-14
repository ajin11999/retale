<script lang="ts">
  import type { HTMLInputAttributes } from "svelte/elements";
  import { cn } from "$lib/utils";
  import { evaluateMath } from "$lib/utils";

  interface Props extends Omit<HTMLInputAttributes, "value" | "type" | "inputmode"> {
    value: number | string | null | undefined;
    ref?: HTMLInputElement | null;
    autofocus?: boolean;
    class?: string;
  }

  let {
    value = $bindable(),
    ref = $bindable(null),
    autofocus = false,
    class: className = "",
    ...rest
  }: Props = $props();

  let el = $state<HTMLInputElement | null>(null);
  
  $effect(() => {
    if (ref !== undefined && ref !== el) {
      ref = el;
    }
  });

  let isEditingExpr = $state(false);

  let text = $state(value == null ? "" : value.toString());

  $effect(() => {
    if (!isEditingExpr && (value == null ? "" : value.toString()) !== text) {
      text = value == null ? "" : value.toString();
    }
  });

  function handleInput(e: Event) {
    const node = e.currentTarget as HTMLInputElement;
    const raw = node.value;

    const hasMath = /[+*/()]/.test(raw) || raw.lastIndexOf("-") > 0;
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
    const safe = raw.replace(/[^\d.-]/g, "");
    text = safe;
    node.value = safe;
    
    const parsed = Number(safe);
    value = isNaN(parsed) || safe === "" || safe === "-" ? null : parsed;
    (rest as any).oninput?.(e);
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

  function commitMath() {
    if (isEditingExpr) {
      const evaled = evaluateMath(text);
      if (evaled != null) {
        value = evaled;
      }
      isEditingExpr = false;
    }
    // Force format string to match value
    text = value == null ? "" : value.toString();
    if (el) el.value = text;
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
