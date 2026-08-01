import { CachePolicy, load_RfqDetail, load_RfqEditorRefData } from "$houdini";
import type { PageLoad } from "./$types";

export const load: PageLoad = async (event) => {
  const [RfqDetail, RfqEditorRefData] = await Promise.all([
    load_RfqDetail({
      event,
      variables: { id: event.params.id },
      policy: CachePolicy.NetworkOnly,
    }),
    load_RfqEditorRefData({
      event,
      policy: CachePolicy.NetworkOnly,
    }),
  ]);

  return { ...RfqDetail, ...RfqEditorRefData };
};
