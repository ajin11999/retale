import { load_DeliveryDetail } from "$houdini";
import type { PageLoad } from "./$types";

export const load: PageLoad = async (event) => {
  return await load_DeliveryDetail({
    event,
    variables: { id: event.params.id },
  });
};
