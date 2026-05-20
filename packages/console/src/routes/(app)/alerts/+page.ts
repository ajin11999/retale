import { load_AlertsInbox } from "$houdini";
import type { PageLoad } from "./$types";

// Explicit Houdini load — both alert feeds together so the inbox renders
// without staging two requests. Unacknowledged-only by default; the
// component toggles to fetch everything when the user asks for history.
export const load: PageLoad = async (event) => {
  return await load_AlertsInbox({
    event,
    variables: { acknowledged: false },
  });
};
