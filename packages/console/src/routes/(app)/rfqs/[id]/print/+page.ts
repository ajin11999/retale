import { CachePolicy, load_RfqPrintDetail, load_RfqPrintRefData } from "$houdini";
import type { PageLoad } from "./$types";

export const load: PageLoad = async (event) => {
  const [RfqPrintDetail, RfqPrintRefData] = await Promise.all([
    load_RfqPrintDetail({
      event,
      variables: { id: event.params.id },
      policy: CachePolicy.NetworkOnly,
    }),
    load_RfqPrintRefData({
      event,
      policy: CachePolicy.NetworkOnly,
    }),
  ]);

  return { ...RfqPrintDetail, ...RfqPrintRefData };
};
