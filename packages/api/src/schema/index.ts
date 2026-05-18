import { createSchema } from "graphql-yoga";
import type { GraphQLContext } from "../lib/context.ts";
import * as authDomain from "./auth.ts";
import * as businessDomain from "./business.ts";
import * as catalogDomain from "./catalog.ts";
import * as customersDomain from "./customers.ts";
import * as deliveriesDomain from "./deliveries.ts";
import * as forecastDomain from "./forecast.ts";
import * as locationsDomain from "./locations.ts";
import * as ordersDomain from "./orders.ts";
import * as posDomain from "./pos.ts";
import * as productAlertsDomain from "./product-alerts.ts";
import * as productImagesDomain from "./product-images.ts";
import * as productsDomain from "./products.ts";
import * as purchaseAlertsDomain from "./purchase-alerts.ts";
import * as purchasesDomain from "./purchases.ts";
import * as receivingDomain from "./receiving.ts";
import * as reorderDomain from "./reorder.ts";
import * as rbacDomain from "./rbac.ts";
import * as stockDomain from "./stock.ts";
import * as trackingDomain from "./tracking.ts";
import * as transfersDomain from "./transfers.ts";
import * as vendorVariantCodesDomain from "./vendor-variant-codes.ts";
import * as vendorsDomain from "./vendors.ts";

// GraphQL schema root. The base defines `Query`/`Mutation` with one field
// each; every domain module `extend`s them. Add domains to both arrays below
// as they are built out (products, purchases, vendors, ...).

const baseTypeDefs = /* GraphQL */ `
  type Query {
    "Liveness probe — returns 'ok' when the API is up."
    health: String!
  }

  type Mutation {
    "Placeholder so domains have a Mutation type to extend."
    _noop: Boolean
  }
`;

const baseResolvers = {
  Query: { health: () => "ok" },
};

export const schema = createSchema<GraphQLContext>({
  typeDefs: [
    baseTypeDefs,
    authDomain.typeDefs,
    rbacDomain.typeDefs,
    productsDomain.typeDefs,
    locationsDomain.typeDefs,
    stockDomain.typeDefs,
    vendorsDomain.typeDefs,
    purchasesDomain.typeDefs,
    deliveriesDomain.typeDefs,
    customersDomain.typeDefs,
    posDomain.typeDefs,
    ordersDomain.typeDefs,
    trackingDomain.typeDefs,
    transfersDomain.typeDefs,
    forecastDomain.typeDefs,
    reorderDomain.typeDefs,
    receivingDomain.typeDefs,
    vendorVariantCodesDomain.typeDefs,
    catalogDomain.typeDefs,
    purchaseAlertsDomain.typeDefs,
    productImagesDomain.typeDefs,
    productAlertsDomain.typeDefs,
    businessDomain.typeDefs,
  ],
  resolvers: [
    baseResolvers,
    authDomain.resolvers,
    rbacDomain.resolvers,
    productsDomain.resolvers,
    locationsDomain.resolvers,
    stockDomain.resolvers,
    vendorsDomain.resolvers,
    purchasesDomain.resolvers,
    deliveriesDomain.resolvers,
    customersDomain.resolvers,
    posDomain.resolvers,
    ordersDomain.resolvers,
    trackingDomain.resolvers,
    transfersDomain.resolvers,
    forecastDomain.resolvers,
    reorderDomain.resolvers,
    receivingDomain.resolvers,
    vendorVariantCodesDomain.resolvers,
    catalogDomain.resolvers,
    purchaseAlertsDomain.resolvers,
    productImagesDomain.resolvers,
    productAlertsDomain.resolvers,
    businessDomain.resolvers,
  ],
});
