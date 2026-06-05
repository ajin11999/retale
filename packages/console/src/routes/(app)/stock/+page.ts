import {
  CachePolicy,
  load_LocationStockLevels,
  load_StockEditorRefData,
} from "$houdini";
import type { PageLoad } from "./$types";

// Explicit Houdini load — the route auto-load injection does not run under this
// toolchain. The per-location count sheet defaults to the unlocated root bucket
// (locationId null), unless a `?location=<id>` param targets a specific location
// (e.g. arriving from the Locations list); the component refetches it when the
// location changes. The reference data (locations + catalog for the add-search)
// loads once.
//
// NetworkOnly for the count sheet: on-hand changes constantly (sales,
// deliveries, other adjustments), so a client-side navigation back into the
// editor must show live levels rather than a stale cached sheet — otherwise the
// numbers only update on a hard page refresh (which forces a fresh SSR load).
export const load: PageLoad = async (event) => {
  const locationId = event.url.searchParams.get("location") || null;
  return {
    ...(await load_LocationStockLevels({
      event,
      variables: { locationId },
      policy: CachePolicy.NetworkOnly,
    })),
    ...(await load_StockEditorRefData({ event })),
    initialLocationId: locationId,
  };
};
