import { CachePolicy, load_RequisitionDetail, load_RequisitionEditorRefData } from "$houdini";
import type { PageLoad } from "./$types";

export const load: PageLoad = async (event) => {
  const [detail, refData] = await Promise.all([
    load_RequisitionDetail({ event, policy: CachePolicy.NetworkOnly, variables: { id: event.params.id } }),
    load_RequisitionEditorRefData({ event })
  ]);
  return {
    ...detail,
    ...refData
  };
};
