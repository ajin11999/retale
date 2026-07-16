import { CachePolicy, load_InterchangeGroupList } from "$houdini";
import type { PageLoad } from "./$types";

export const load: PageLoad = async (event) => {
  return await load_InterchangeGroupList({ event, policy: CachePolicy.NetworkOnly });
};
