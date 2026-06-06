import { CachePolicy, load_SessionVariants } from "$houdini";
import type { PageLoad } from "./$types";

// Explicit Houdini load — bound to the route param. NetworkOnly so a sale just
// closed from the POS (Flutter) shows up rather than serving a stale cached
// breakdown.
export const load: PageLoad = async (event) => {
  return await load_SessionVariants({
    event,
    variables: { id: event.params.id },
    policy: CachePolicy.NetworkOnly,
  });
};
