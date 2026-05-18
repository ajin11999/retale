// Workshop GraphQL domain: the workshop settings (identity + the configurable
// PO message template) and the rendered purchase-order message that applies
// it. Rendering is a pure read; editing settings is admin-gated.

import { GraphQLError } from "graphql";
import { requirePermission } from "../lib/authz.ts";
import type { GraphQLContext } from "../lib/context.ts";
import { renderPurchaseOrderMessage } from "../services/purchase-message-service.ts";
import { PurchaseError } from "../services/purchase-service.ts";
import {
  getWorkshopSettings,
  updateWorkshopSettings,
} from "../services/workshop-service.ts";

export const typeDefs = /* GraphQL */ `
  "Workshop-level configuration: identity and the PO message template."
  type WorkshopSettings {
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
    workshopSettings: WorkshopSettings!
    "Render a purchase order into a sendable message (greeting + lines + footer)."
    purchaseMessage(purchaseId: ID!): PurchaseMessage!
  }

  extend type Mutation {
    updateWorkshopSettings(
      name: String
      phone: String
      email: String
      poGreeting: String
      poFooter: String
    ): WorkshopSettings!
  }
`;

const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

export const resolvers = {
  WorkshopSettings: {
    updatedAt: (s: { updatedAt: Date | string | null }) => iso(s.updatedAt),
  },

  Query: {
    workshopSettings: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
      await requirePermission(ctx, "admin.settings.manage");
      return getWorkshopSettings();
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
    updateWorkshopSettings: async (
      _: unknown,
      args: Record<string, string | null | undefined>,
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "admin.settings.manage");
      return updateWorkshopSettings(args);
    },
  },
};
