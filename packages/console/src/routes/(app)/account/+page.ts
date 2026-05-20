import { load_AccountMe } from "$houdini";
import type { PageLoad } from "./$types";

// Explicit Houdini load — the auth guard in (app)/+layout.server.ts already
// guarantees a viewer, but we still fetch the user here to read its
// twoFactorEnabled flag (which the layout viewer does not surface).
export const load: PageLoad = async (event) => {
  return await load_AccountMe({ event });
};
