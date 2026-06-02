<script lang="ts">
  import { cn } from "$lib/utils";

  interface Option {
    value: string;
    label: string;
  }

  let {
    options,
    value = $bindable(""),
    placeholder = "",
    disabled = false,
    id,
    class: className = "",
    onCreate,
    createLabel = (q) => `Create “${q}”`,
  }: {
    options: Option[];
    value?: string;
    placeholder?: string;
    disabled?: boolean;
    id?: string;
    class?: string;
    /**
     * When supplied, a "create" row appears at the bottom of the menu whenever
     * the user has typed a query. Choosing it hands the trimmed query back to
     * the parent (which creates the record, then sets `value`). Odoo-style
     * quick-create.
     */
    onCreate?: (query: string) => void | Promise<void>;
    /** Label for the create row; defaults to `Create “<query>”`. */
    createLabel?: (query: string) => string;
  } = $props();

  // `text` is the input's editable contents. While the menu is closed it shows
  // the selected option's label; while open the user types into it to search.
  // `dirty` distinguishes "just opened, show everything" from "user is typing".
  let text = $state("");
  let open = $state(false);
  let dirty = $state(false);
  let highlight = $state(0);

  let inputEl: HTMLInputElement | undefined = $state();
  let optionEls = $state<(HTMLButtonElement | undefined)[]>([]);

  // Stable per-instance id so the combobox input can point at its listbox.
  const listId = `combobox-${Math.random().toString(36).slice(2)}`;

  const selectedLabel = $derived(
    options.find((o) => o.value === value)?.label ?? "",
  );

  // Reflect external selection changes into the field while it isn't being
  // edited (e.g. the form resets `value`).
  $effect(() => {
    if (!open) text = selectedLabel;
  });

  const filtered = $derived.by(() => {
    if (!dirty) return options;
    const q = text.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  });

  // The "+ Create …" row shows once the user has typed something and the parent
  // opted in via `onCreate`. It sits at index `filtered.length` for keyboard
  // navigation, after all matching options.
  const query = $derived(text.trim());
  const showCreate = $derived(!!onCreate && query.length > 0);
  const optionCount = $derived(filtered.length + (showCreate ? 1 : 0));

  // Keep the highlighted row visible as the user arrows through it.
  $effect(() => {
    if (open) optionEls[highlight]?.scrollIntoView({ block: "nearest" });
  });

  function openMenu() {
    if (disabled) return;
    open = true;
    dirty = false;
    // Clear the box so the user can type a fresh search without first deleting
    // the selected label. Leaving without choosing reverts it (onFocusOut).
    text = "";
    const idx = options.findIndex((o) => o.value === value);
    highlight = idx >= 0 ? idx : 0;
  }

  function choose(opt: Option) {
    value = opt.value;
    text = opt.label;
    open = false;
    dirty = false;
  }

  // Hand the typed query to the parent's quick-create, then close. The parent
  // creates the record and sets `value`; the new option arriving in `options`
  // resolves its label into the (now closed) field via the effect above.
  async function create() {
    const q = query;
    if (!onCreate || !q) return;
    open = false;
    dirty = false;
    await onCreate(q);
  }

  function onInput() {
    open = true;
    dirty = true;
    highlight = 0;
  }

  function onKeydown(e: KeyboardEvent) {
    if (disabled) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) return openMenu();
      highlight = Math.min(highlight + 1, optionCount - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      highlight = Math.max(highlight - 1, 0);
    } else if (e.key === "Enter") {
      if (open && highlight < filtered.length) {
        e.preventDefault();
        choose(filtered[highlight]);
      } else if (open && showCreate && highlight === filtered.length) {
        e.preventDefault();
        create();
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        open = false;
        dirty = false;
        text = selectedLabel;
      }
    }
  }

  // Close when focus leaves the whole control, reverting any half-typed query.
  function onFocusOut(e: FocusEvent) {
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget instanceof Node && e.currentTarget.contains(next))
      return;
    open = false;
    dirty = false;
    text = selectedLabel;
  }
</script>

<div class="relative" onfocusout={onFocusOut}>
  <input
    bind:this={inputEl}
    {id}
    type="text"
    role="combobox"
    aria-expanded={open}
    aria-controls={listId}
    aria-autocomplete="list"
    autocomplete="off"
    {placeholder}
    {disabled}
    bind:value={text}
    onfocus={openMenu}
    onclick={openMenu}
    oninput={onInput}
    onkeydown={onKeydown}
    class={cn(
      "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
  />

  {#if open && (filtered.length > 0 || showCreate)}
    <ul
      id={listId}
      role="listbox"
      class="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-md border bg-popover py-1 shadow-md"
    >
      {#each filtered as opt, i (opt.value)}
        <li>
          <button
            bind:this={optionEls[i]}
            type="button"
            role="option"
            aria-selected={opt.value === value}
            onmousedown={(e) => {
              // Keep focus on the input so the menu doesn't blur-close first.
              e.preventDefault();
              choose(opt);
            }}
            onmouseenter={() => (highlight = i)}
            class={cn(
              "flex w-full items-center px-3 py-1.5 text-left text-sm",
              i === highlight ? "bg-accent text-accent-foreground" : "",
              opt.value === value ? "font-medium" : "",
            )}
          >
            {opt.label}
          </button>
        </li>
      {/each}
      {#if showCreate}
        <li>
          <button
            bind:this={optionEls[filtered.length]}
            type="button"
            role="option"
            aria-selected={false}
            onmousedown={(e) => {
              e.preventDefault();
              create();
            }}
            onmouseenter={() => (highlight = filtered.length)}
            class={cn(
              "flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-sm",
              filtered.length > 0 ? "mt-1 border-t pt-2" : "",
              filtered.length === highlight ? "bg-accent text-accent-foreground" : "",
            )}
          >
            <span class="text-base leading-none text-muted-foreground">+</span>
            {createLabel(query)}
          </button>
        </li>
      {/if}
    </ul>
  {:else if open && dirty}
    <div
      class="absolute z-20 mt-1 w-full rounded-md border bg-popover px-3 py-2 text-sm text-muted-foreground shadow-md"
    >
      No matches.
    </div>
  {/if}
</div>
