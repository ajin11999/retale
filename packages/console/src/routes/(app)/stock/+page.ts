import { load_LocationStockLevels, load_StockEditorRefData } from "$houdini";
import type { PageLoad } from "./$types";

// Explicit Houdini load — the route auto-load injection does not run under this
// toolchain. The per-location count sheet defaults to the unlocated root bucket
// (locationId null); the component refetches it when the location changes. The
// reference data (locations + catalog for the add-search) loads once.
export const load: PageLoad = async (event) => {
  return {
    ...(await load_LocationStockLevels({ event, variables: { locationId: null } })),
    ...(await load_StockEditorRefData({ event })),
  };
};
