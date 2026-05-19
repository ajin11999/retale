import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

// The console has no dashboard yet — land on the products list.
export const load: PageLoad = () => {
  redirect(307, "/products");
};
