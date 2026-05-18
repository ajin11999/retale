import { error } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params, parent }) => {
  const { snapshot } = await parent();
  const product = snapshot?.products.find((p) => p.id === params.id);
  if (!product) error(404, "Product not found in the catalog.");
  return { product };
};
