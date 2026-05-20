import { load_ReceivingCheck } from "$houdini";
import type { PageLoad } from "./$types";

// Explicit Houdini load — the route auto-load injection does not run under
// this toolchain, so the query is loaded here with the purchase id as input.
export const load: PageLoad = async (event) => {
  return await load_ReceivingCheck({
    event,
    variables: { purchaseId: event.params.id },
  });
};
