import { load_BusinessSettingsView } from "$houdini";
import type { PageLoad } from "./$types";

// Explicit Houdini load — the businessSettings query is gated on
// admin.settings.manage, so an unauthorised viewer will see a GraphQL error
// surfaced by the page rather than a forbidden status.
export const load: PageLoad = async (event) => {
  return await load_BusinessSettingsView({ event });
};
