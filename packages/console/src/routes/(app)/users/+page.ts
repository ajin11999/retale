import { load_UserAdmin } from "$houdini";
import type { PageLoad } from "./$types";

// Explicit Houdini load — auto-load injection is off. Users + roles in one
// round-trip so the table can render role chips by name without joining
// client-side against a separate fetch.
export const load: PageLoad = async (event) => {
  return await load_UserAdmin({ event });
};
