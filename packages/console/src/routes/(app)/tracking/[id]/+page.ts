import { load_TrackingAccountDetail } from "$houdini";
import type { PageLoad } from "./$types";

export const load: PageLoad = async (event) => {
  return await load_TrackingAccountDetail({
    event,
    variables: { id: event.params.id },
  });
};
