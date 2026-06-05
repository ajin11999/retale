import { CachePolicy, load_CustomerList } from "$houdini";
import type { PageLoad } from "./$types";

// Explicit Houdini load — the route auto-load injection does not run under
// this toolchain, so the query is loaded here and synced into the component
// store of the same name. NetworkOnly so balances stay fresh after an order
// is closed elsewhere (the cached list would otherwise show a stale balance).
export const load: PageLoad = async (event) => {
  return await load_CustomerList({ event, policy: CachePolicy.NetworkOnly });
};
