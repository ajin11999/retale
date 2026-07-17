import { load_NewTransferLocations } from "$houdini";
import type { PageLoad } from "./$types";

export const load: PageLoad = async (event) => {
  return {
    ...(await load_NewTransferLocations({ event })),
  };
};
