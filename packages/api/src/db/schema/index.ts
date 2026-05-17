// Drizzle table definitions, one file per domain. Re-exported here so the
// db client and drizzle-kit pick up every table from a single entry point.
//
// Populated as domains are built out (products, purchases, ...).

export * from "./auth.ts";
export * from "./products.ts";
export * from "./locations.ts";
export * from "./stock.ts";
export * from "./vendors.ts";
export * from "./purchases.ts";
export * from "./deliveries.ts";
export * from "./customers.ts";
export * from "./pos.ts";
export * from "./orders.ts";
export * from "./tracking.ts";
