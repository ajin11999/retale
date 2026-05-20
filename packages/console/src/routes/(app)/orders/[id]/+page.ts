import { load_OrderDetail } from "$houdini";
import type { PageLoad } from "./$types";

export const load: PageLoad = async (event) => {
  return await load_OrderDetail({
    event,
    variables: { id: event.params.id },
  });
};
