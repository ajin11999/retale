import { CachePolicy, load_TrackingAccountList } from "$houdini";
import type { PageLoad } from "./$types";

// Explicit Houdini load — auto-load injection is off. Includes archived so
// the list can show them; the table filters interactively. NetworkOnly so
// returning here after creating / archiving an account reflects the latest
// shape immediately instead of serving a stale cached tree.
export const load: PageLoad = async (event) => {
  return await load_TrackingAccountList({
    event,
    policy: CachePolicy.NetworkOnly,
  });
};
