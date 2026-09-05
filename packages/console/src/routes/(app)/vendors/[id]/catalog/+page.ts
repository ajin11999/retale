import { load_VendorCatalog } from "$houdini";
import type { PageLoad } from "./$types";

// Explicit Houdini load — the route auto-load injection does not run under
// this toolchain, so the query is loaded here with the route param as vendor.
export const load: PageLoad = async (event) => {
  return await load_VendorCatalog({
    event,
    variables: { vendorId: event.params.id },
  });
};
