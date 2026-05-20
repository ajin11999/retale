import { load_RoleAdmin } from "$houdini";
import type { PageLoad } from "./$types";

// Explicit Houdini load — auto-load injection is off; the page renders the
// roles list together with the permission catalog so the editor can render
// keys grouped by domain without a second round-trip.
export const load: PageLoad = async (event) => {
  return await load_RoleAdmin({ event });
};
