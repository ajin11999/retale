import { load_CategoryList } from "$houdini";
import type { PageLoad } from "./$types";

// Explicit Houdini load — the route auto-load injection does not run under
// this toolchain, so the query is loaded here and synced into the component
// store of the same name.
export const load: PageLoad = async (event) => {
  return await load_CategoryList({ event });
};
