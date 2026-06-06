import { CachePolicy, load_SessionList } from "$houdini";
import type { PageLoad } from "./$types";

// Explicit Houdini load — auto-load injection is off. The pointsOfSale list
// is fetched alongside so rows can show the POS code/name without joining
// on the client against a separate query.
//
// NetworkOnly: sessions are opened/closed externally from the POS (Flutter),
// so the default CacheOrNetwork policy would re-serve a stale cached list on
// navigation — a closed session would still show "Open" until a hard refresh.
export const load: PageLoad = async (event) => {
  return await load_SessionList({ event, policy: CachePolicy.NetworkOnly });
};
