import { CachePolicy, load_PurchaseList } from "$houdini";
import type { PageLoad } from "./$types";

// Explicit Houdini load — the route auto-load injection does not run under
// this toolchain, so the query is loaded here and synced into the component
// store of the same name. NetworkOnly so returning here after creating a
// purchase (which navigates away to its detail page) reflects it immediately
// instead of serving the stale cached list.
export const load: PageLoad = async (event) => {
  return await load_PurchaseList({ event, policy: CachePolicy.NetworkOnly });
};
