// Business GraphQL domain: the business settings — identity plus the
// configurable PO message template. Editing is admin-gated. The rendered
// purchase-order message that consumes the template lives in the purchases
// domain (`purchaseSendDraft`).

import { requirePermission } from "../lib/authz.ts";
import type { GraphQLContext } from "../lib/context.ts";
import {
  clearBusinessLogo,
  getBusinessSettings,
  updateBusinessSettings,
} from "../services/business-service.ts";

export const typeDefs = /* GraphQL */ `
  "Business-level configuration: identity and the PO message template."
  type BusinessSettings {
    name: String!
    phone: String
    email: String
    "Public URL of the business logo (PNG), shown on the PO letterhead. Uploaded via POST /business-logo."
    logoUrl: String
    "Greeting prepended to a rendered purchase-order message."
    poGreeting: String
    "Footer appended to a rendered purchase-order message."
    poFooter: String
    updatedAt: String
  }

  extend type Query {
    businessSettings: BusinessSettings!
  }

  extend type Mutation {
    updateBusinessSettings(
      name: String
      phone: String
      email: String
      poGreeting: String
      poFooter: String
    ): BusinessSettings!
    "Remove the business logo (clears the URL and deletes the stored file)."
    clearBusinessLogo: BusinessSettings!
  }
`;

const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

export const resolvers = {
  BusinessSettings: {
    updatedAt: (s: { updatedAt: Date | string | null }) => iso(s.updatedAt),
  },

  Query: {
    businessSettings: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
      await requirePermission(ctx, "admin.settings.manage");
      return getBusinessSettings();
    },
  },

  Mutation: {
    updateBusinessSettings: async (
      _: unknown,
      args: Record<string, string | null | undefined>,
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "admin.settings.manage");
      return updateBusinessSettings(args);
    },
    clearBusinessLogo: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
      await requirePermission(ctx, "admin.settings.manage");
      return clearBusinessLogo();
    },
  },
};
