import { CachePolicy, load_RfqList } from "$houdini";
import type { PageLoad } from "./$types";

export const load: PageLoad = async (event) => {
  return await load_RfqList({ event, policy: CachePolicy.NetworkOnly });
};
