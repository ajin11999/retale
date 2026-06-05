import { load_OrderDetail, load_OrderEditorProducts } from "$houdini";
import type { PageLoad } from "./$types";

// The catalog ref data has no variables and loads once; OrderDetail is what
// refetch() re-pulls after adding a line or payment.
export const load: PageLoad = async (event) => {
  return {
    ...(await load_OrderDetail({
      event,
      variables: { id: event.params.id },
    })),
    ...(await load_OrderEditorProducts({ event })),
  };
};
