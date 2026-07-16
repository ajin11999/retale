import { CachePolicy, load_InterchangeGroupsBulkAdd } from "$houdini";
import type { PageLoad } from "./$types";

export const load: PageLoad = async (event) => {
  return await load_InterchangeGroupsBulkAdd({ event, policy: CachePolicy.NetworkOnly });
};
