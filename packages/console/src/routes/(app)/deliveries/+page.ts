import { CachePolicy, load_DeliveryList } from "$houdini";
import type { PageLoad } from "./$types";

// Explicit Houdini load — fetches locations alongside so the New form can
// pick a target location without a second round-trip. NetworkOnly so returning
// here after creating a delivery reflects the new row instead of stale cache.
export const load: PageLoad = async (event) => {
  return await load_DeliveryList({ event, policy: CachePolicy.NetworkOnly });
};
