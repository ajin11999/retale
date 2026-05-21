import { CachePolicy, load_ProductList } from "$houdini";
import type { PageLoad } from "./$types";

// Explicit Houdini load — the route auto-load injection does not run under
// this toolchain, so the query is loaded here and synced into the component
// store of the same name. NetworkOnly so returning here after creating a
// product (which navigates away to its detail page) reflects the new product
// immediately instead of serving the stale cached list.
export const load: PageLoad = async (event) => {
  return await load_ProductList({ event, policy: CachePolicy.NetworkOnly });
};
