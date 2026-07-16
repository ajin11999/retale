import { CachePolicy, load_InterchangeGroupsOptions } from "$houdini";
import type { PageLoad } from "./$types";

export const load: PageLoad = async (event) => {
  return await load_InterchangeGroupsOptions({ event, policy: CachePolicy.NetworkOnly });
};
