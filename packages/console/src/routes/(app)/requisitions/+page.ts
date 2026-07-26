import { CachePolicy, load_RequisitionList } from "$houdini";
import type { PageLoad } from "./$types";

export const load: PageLoad = async (event) => {
  return await load_RequisitionList({ event, policy: CachePolicy.NetworkOnly });
};
