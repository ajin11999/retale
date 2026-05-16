import { createSchema } from "graphql-yoga";
import type { GraphQLContext } from "../lib/context.ts";
import * as authDomain from "./auth.ts";
import * as locationsDomain from "./locations.ts";
import * as productsDomain from "./products.ts";
import * as purchasesDomain from "./purchases.ts";
import * as rbacDomain from "./rbac.ts";
import * as stockDomain from "./stock.ts";
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
  ],
});
