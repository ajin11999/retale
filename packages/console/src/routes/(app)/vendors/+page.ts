import { CachePolicy, load_VendorList } from "$houdini";
import type { PageLoad } from "./$types";

// Explicit Houdini load — the route auto-load injection does not run under
// this toolchain, so the query is loaded here and synced into the component
// store of the same name. NetworkOnly so returning here after creating a
// vendor reflects the new row instead of a stale cached list.
export const load: PageLoad = async (event) => {
  return await load_VendorList({ event, policy: CachePolicy.NetworkOnly });
};
