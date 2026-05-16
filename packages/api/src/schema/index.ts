import { createSchema } from "graphql-yoga";
import type { GraphQLContext } from "../lib/context.ts";
import * as authDomain from "./auth.ts";
import * as productsDomain from "./products.ts";
import * as rbacDomain from "./rbac.ts";

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
  typeDefs: [baseTypeDefs, authDomain.typeDefs, rbacDomain.typeDefs, productsDomain.typeDefs],
  resolvers: [baseResolvers, authDomain.resolvers, rbacDomain.resolvers, productsDomain.resolvers],
});
