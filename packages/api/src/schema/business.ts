// Business GraphQL domain: the business settings (identity + the configurable
// PO message template) and the rendered purchase-order message that applies
// it. Rendering is a pure read; editing settings is admin-gated.

import { GraphQLError } from "graphql";
import { requirePermission } from "../lib/authz.ts";
import type { GraphQLContext } from "../lib/context.ts";
import {
  getBusinessSettings,
  updateBusinessSettings,
} from "../services/business-service.ts";
import { renderPurchaseOrderMessage } from "../services/purchase-message-service.ts";
import { PurchaseError } from "../services/purchase-service.ts";

export const typeDefs = /* GraphQL */ `
  "Business-level configuration: identity and the PO message template."
  type BusinessSettings {
    name: String!
    phone: String
    email: String
    "Greeting prepended to a rendered purchase-order message."
    poGreeting: String
    "Footer appended to a rendered purchase-order message."
    poFooter: String
    updatedAt: String
  }

  "A purchase order rendered as a vendor-ready message."
  type PurchaseMessage {
    subject: String!
    body: String!
  }

  extend type Query {
    businessSettings: BusinessSettings!
    "Render a purchase order into a sendable message (greeting + lines + footer)."
    purchaseMessage(purchaseId: ID!): PurchaseMessage!
  }

  extend type Mutation {
    updateBusinessSettings(
      name: String
      phone: String
      email: String
      poGreeting: String
      poFooter: String
    ): BusinessSettings!
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
    purchaseMessage: async (
      _: unknown,
      args: { purchaseId: string },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "purchase.send");
      try {
        return await renderPurchaseOrderMessage(args.purchaseId);
      } catch (e) {
        if (e instanceof PurchaseError) {
          throw new GraphQLError(e.message, { extensions: { code: e.code } });
        }
        throw e;
      }
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
  },
};
