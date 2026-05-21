import { CachePolicy, load_CategoryList } from "$houdini";
import type { PageLoad } from "./$types";

// Explicit Houdini load — the route auto-load injection does not run under
// this toolchain, so the query is loaded here and synced into the component
// store of the same name. NetworkOnly so returning here reflects newly
// created / changed categories immediately instead of a stale cached tree.
export const load: PageLoad = async (event) => {
  return await load_CategoryList({ event, policy: CachePolicy.NetworkOnly });
};
