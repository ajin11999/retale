import { load_PurchaseDetail, load_PurchaseEditorRefData } from "$houdini";
import type { PageLoad } from "./$types";

// Explicit Houdini load — the route auto-load injection does not run under
// this toolchain, so the queries are loaded here with the route param as the
// purchase id. The vendor/catalog ref data has no variables and loads once;
// the detail query is what refetch() re-pulls after each edit.
export const load: PageLoad = async (event) => {
  return {
    ...(await load_PurchaseDetail({
      event,
      variables: { id: event.params.id },
    })),
    ...(await load_PurchaseEditorRefData({ event })),
  };
};
