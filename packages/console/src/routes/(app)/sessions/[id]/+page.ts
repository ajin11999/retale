import { CachePolicy, load_SessionDetail } from "$houdini";
import type { PageLoad } from "./$types";

// Explicit Houdini load — bound to the route param. Includes the orders
// closed in this session so the detail can render them inline.
//
// NetworkOnly: the session can be closed externally from the POS (Flutter),
// so the default CacheOrNetwork policy would re-serve a stale cached detail
// (still "Open", no closing cash/variance) until a hard refresh.
export const load: PageLoad = async (event) => {
  return await load_SessionDetail({
    event,
    variables: { id: event.params.id },
    policy: CachePolicy.NetworkOnly,
  });
};
