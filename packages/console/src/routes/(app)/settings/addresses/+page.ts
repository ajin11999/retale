import { load_AddressBookView } from "$houdini";
import type { PageLoad } from "./$types";

// Explicit Houdini load — the addresses query is gated on
// admin.settings.manage, so an unauthorised viewer sees a surfaced GraphQL
// error rather than a forbidden status.
export const load: PageLoad = async (event) => {
  return await load_AddressBookView({ event });
};
