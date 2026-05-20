import { load_SessionDetail } from "$houdini";
import type { PageLoad } from "./$types";

// Explicit Houdini load — bound to the route param. Includes the orders
// closed in this session so the detail can render them inline.
export const load: PageLoad = async (event) => {
  return await load_SessionDetail({
    event,
    variables: { id: event.params.id },
  });
};
