import {
  createTable,
  type RowData,
  type TableOptions,
  type TableOptionsResolved,
  type TableState,
  type Updater,
} from "@tanstack/table-core";

/**
 * Layered, lazy object merge. Later sources win; getters are preserved (read
 * live on every access) so reactive `get data()` options stay reactive through
 * the merge. This is what lets the table re-render when its data changes.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mergeObjects<T extends object>(...sources: any[]): T {
  return new Proxy({} as T, {
    has: (_, key) => sources.some((s) => s != null && key in s),
    get(_, key) {
      for (let i = sources.length - 1; i >= 0; i--) {
        const src = sources[i] as Record<string | symbol, unknown> | null;
        if (src != null && key in src && src[key] !== undefined) {
          return src[key];
        }
      }
      return undefined;
    },
    ownKeys() {
      const keys = new Set<string | symbol>();
      for (const src of sources) {
        if (src != null) for (const k of Reflect.ownKeys(src)) keys.add(k);
      }
      return [...keys];
    },
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
    }),
  });
}

/**
 * Svelte 5 wrapper around TanStack `@tanstack/table-core`. The table's state
 * lives in a rune, so `table.getState()`, `getRowModel()`, etc. are reactive.
 *
 * Pass reactive inputs as getters, e.g. `{ get data() { return rows } }`.
 */
export function createSvelteTable<TData extends RowData>(
  options: TableOptions<TData>,
) {
  const resolvedOptions = mergeObjects<TableOptionsResolved<TData>>(
    {
      state: {},
      onStateChange() {},
      renderFallbackValue: null,
      mergeOptions: (
        defaultOptions: TableOptions<TData>,
        opts: Partial<TableOptions<TData>>,
      ) => mergeObjects<TableOptionsResolved<TData>>(defaultOptions, opts),
    },
    options,
  );

  const table = createTable(resolvedOptions);
  let state = $state<Partial<TableState>>(table.initialState);

  function updateOptions() {
    table.setOptions((prev) =>
      mergeObjects<TableOptionsResolved<TData>>(prev, options, {
        state: mergeObjects<TableState>(state, options.state ?? {}),
        onStateChange: (updater: Updater<TableState>) => {
          state =
            updater instanceof Function
              ? updater(state as TableState)
              : updater;
          options.onStateChange?.(updater);
        },
      }),
    );
  }

  updateOptions();
  $effect.pre(() => {
    updateOptions();
  });

  return table;
}
