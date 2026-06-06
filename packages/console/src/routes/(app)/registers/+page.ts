import { load_RegisterList } from "$houdini";
import type { PageLoad } from "./$types";

// Explicit Houdini load — auto-load injection is off. The locations list is
// fetched alongside so the editor can offer a location picker and rows can
// show each register's location name without a second round-trip.
export const load: PageLoad = async (event) => {
  return await load_RegisterList({ event });
};
