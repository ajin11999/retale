import { CachePolicy, load_BulkAdd } from "$houdini";
import type { PageLoad } from "./$types";

// Explicit Houdini load — the route auto-load injection does not run under this
// toolchain. Only the category list is needed (the batch Category picker);
// NetworkOnly so a category created elsewhere shows up without a hard refresh.
export const load: PageLoad = async (event) => {
  return await load_BulkAdd({ event, policy: CachePolicy.NetworkOnly });
};
