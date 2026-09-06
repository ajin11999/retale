import { CachePolicy, load_OrderList } from "$houdini";
import type { PageLoad } from "./$types";

// Explicit Houdini load — recent orders across all sessions, or for one
// customer when `?customer=<id>` targets it (e.g. arriving from the Customers
// list or a customer detail page). The orders query has no built-in date
// filter, so we cap the list at 200 and let the client filter by status /
// search. NetworkOnly so returning here after creating a sale reflects the
// new order instead of a stale cached list.
export const load: PageLoad = async (event) => {
  const customerId = event.url.searchParams.get("customer") || null;
  return {
    ...(await load_OrderList({
      event,
      variables: { customerId },
      policy: CachePolicy.NetworkOnly,
    })),
    initialCustomerId: customerId,
  };
};
