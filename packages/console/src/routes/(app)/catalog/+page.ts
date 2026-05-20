import { load_CatalogManage } from "$houdini";
import type { PageLoad } from "./$types";

// Explicit Houdini load — fetches the product set and recent publish history
// in one round-trip so the catalog manager can render bulk-select + publish
// button + history without staging additional requests.
export const load: PageLoad = async (event) => {
  return await load_CatalogManage({ event });
};
