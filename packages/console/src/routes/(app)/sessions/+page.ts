import { load_SessionList } from "$houdini";
import type { PageLoad } from "./$types";

// Explicit Houdini load — auto-load injection is off. The pointsOfSale list
// is fetched alongside so rows can show the POS code/name without joining
// on the client against a separate query.
export const load: PageLoad = async (event) => {
  return await load_SessionList({ event });
};
