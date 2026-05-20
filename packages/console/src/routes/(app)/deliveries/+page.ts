import { load_DeliveryList } from "$houdini";
import type { PageLoad } from "./$types";

// Explicit Houdini load — fetches locations alongside so the New form can
// pick a target location without a second round-trip.
export const load: PageLoad = async (event) => {
  return await load_DeliveryList({ event });
};
