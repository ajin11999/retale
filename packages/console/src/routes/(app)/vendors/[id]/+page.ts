import { load_VendorDetail } from "$houdini";
import type { PageLoad } from "./$types";

// Explicit Houdini load — the route auto-load injection does not run under
// this toolchain, so the query is loaded here with the route param as its id.
export const load: PageLoad = async (event) => {
  return await load_VendorDetail({
    event,
    variables: { id: event.params.id },
  });
};
