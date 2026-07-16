<script lang="ts">
  // A floating "does this already exist?" panel for create/edit name fields.
  // Place it inside a `position: relative` wrapper directly under the name
  // <input>; it anchors to the bottom of that wrapper. Matching is a normalized
  // substring (see normalizeName) — punctuation/spacing-insensitive, no fuzzy
  // dependency. All filtering is client-side over a list the page already holds.
  import { normalizeName } from "$lib/utils";

  interface Candidate {
    id: string;
    name: string;
    /** Optional sub-label, e.g. "Archived" or a category name. */
    note?: string | null;
  }

  let {
    query,
    items,
    excludeId = null,
    minChars = 3,
    limit = 6,
    noun = "item",
  }: {
    query: string;
    items: Candidate[];
    /** Skip this row (the entity currently being edited). */
    excludeId?: string | null;
    minChars?: number;
    limit?: number;
    /** Singular noun for the heading, e.g. "product". */
    noun?: string;
  } = $props();

  const matches = $derived.by(() => {
    const q = normalizeName(query ?? "");
    if (q.length < minChars) return [];
    const seen = items.filter(
      (it) => it.id !== excludeId && normalizeName(it.name).includes(q),
    );
    // Exact (normalized) matches first — those are the real duplicates.
    seen.sort((a, b) => {
      const ax = normalizeName(a.name) === q ? 0 : 1;
      const bx = normalizeName(b.name) === q ? 0 : 1;
      return ax - bx || a.name.localeCompare(b.name);
    });
    return seen.slice(0, limit);
  });

  const exact = $derived(
    matches.some((m) => normalizeName(m.name) === normalizeName(query ?? "")),
  );

  let show = $state(false);

  function trackFocus(node: HTMLElement) {
    const parent = node.parentElement;
    if (!parent) return;
    const input = parent.querySelector("input");
    if (!input) return;

    const onFocus = () => (show = true);
    const onBlur = () => (show = false);

    input.addEventListener("focus", onFocus);
    input.addEventListener("blur", onBlur);
    if (document.activeElement === input) show = true;

    return {
      destroy() {
        input.removeEventListener("focus", onFocus);
        input.removeEventListener("blur", onBlur);
      },
    };
  }
</script>

{#if matches.length > 0}
  <div
    use:trackFocus
    class="absolute left-0 top-full z-20 mt-1 w-full overflow-hidden rounded-md border bg-popover shadow-md {show ? '' : 'hidden'}"
  >
    <p
      class="border-b px-3 py-1.5 text-xs font-medium {exact
        ? 'bg-destructive/10 text-destructive'
        : 'bg-amber-50 text-amber-800'}"
    >
      {exact
        ? `A ${noun} with this exact name already exists`
        : `Similar ${noun}${matches.length === 1 ? "" : "s"} already exist`}
    </p>
    <ul class="max-h-56 divide-y overflow-y-auto text-sm">
      {#each matches as m (m.id)}
        <li>
          <div class="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-muted-foreground">
            <span class="truncate">{m.name}</span>
            {#if m.note}
              <span class="shrink-0 text-xs">{m.note}</span>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  </div>
{/if}
