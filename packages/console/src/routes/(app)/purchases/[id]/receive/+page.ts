import { load_ReceivingCheck, load_ReceivingRefData } from "$houdini";
import type { PageLoad } from "./$types";

// Explicit Houdini load — the route auto-load injection does not run under
// this toolchain. The receiving state takes the purchase id; the static
// locations/catalog ref data has no variables and loads once.
export const load: PageLoad = async (event) => {
  return {
    ...(await load_ReceivingCheck({
      event,
      variables: { purchaseId: event.params.id },
    })),
    ...(await load_ReceivingRefData({ event })),
  };
};
