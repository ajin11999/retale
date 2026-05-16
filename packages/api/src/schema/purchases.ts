// Purchases GraphQL domain: purchase-order header / section / item CRUD, plus
// the append-only send log. Purchases are documents — nothing here moves
// stock; that happens at delivery commit (Phase 3). Money / qty are Float
// (integer minor units / smallest-unit counts; Float is exact past 2^31).

import { GraphQLError } from "graphql";
import { requirePermission } from "../lib/authz.ts";
import type { GraphQLContext } from "../lib/context.ts";
import * as purchases from "../services/purchase-service.ts";
import * as vendors from "../services/vendor-service.ts";

export const typeDefs = /* GraphQL */ `
  enum PurchaseStatus { open complete cancelled }
  enum PurchaseSendChannel { whatsapp email manual }
  enum PurchaseSendStatus { prepared sent }

  type Purchase {
    id: ID!
    vendorId: ID
    vendor: Vendor
    "Vendor name at create time; free-text for ad-hoc (vendorId null) purchases."
    snapshotVendorName: String!
    date: String!
    sourceDocument: String
    memo: String
    status: PurchaseStatus!
    "Bumped by every content edit; snapshotted into each send row."
    revision: Int!
    lastSentAt: String
    cancelledAt: String
    createdAt: String!
    updatedAt: String!
    sections: [PurchaseSection!]!
    items: [PurchaseItem!]!
    sends: [PurchaseSend!]!
    "Σ(qtyOrdered × unitCostMinor) across items — the vendor invoice total."
    totalInvoiceCost: Float!
    "True when the PO has content edits not covered by the latest send."
    hasUnsentChanges: Boolean!
  }

  type PurchaseSection {
    id: ID!
    purchaseId: ID!
    name: String!
    sortOrder: Int!
    items: [PurchaseItem!]!
  }

  type PurchaseItem {
    id: ID!
    purchaseId: ID!
    sectionId: ID
    variantId: ID
    "Free-text line label; required (and the line identity) for non-stock lines."
    description: String
    qtyOrdered: Float!
    qtyDelivered: Float!
    unitCostMinor: Float!
    sortOrder: Int!
  }

  type PurchaseSend {
    id: ID!
    purchaseId: ID!
    channel: PurchaseSendChannel!
    recipient: String!
    revision: Int!
    status: PurchaseSendStatus!
    sentAt: String
    note: String
    createdAt: String!
  }

  extend type Query {
    purchases(
      status: PurchaseStatus
      vendorId: ID
      includeCancelled: Boolean
    ): [Purchase!]!
    purchase(id: ID!): Purchase
  }

  extend type Mutation {
    createPurchase(
      vendorId: ID
      snapshotVendorName: String
      date: String!
      sourceDocument: String
      memo: String
    ): Purchase!
    updatePurchase(
      id: ID!
      vendorId: ID
      snapshotVendorName: String
      date: String
      sourceDocument: String
      memo: String
    ): Purchase!
    cancelPurchase(id: ID!): Purchase!

    createPurchaseSection(purchaseId: ID!, name: String!, sortOrder: Int): PurchaseSection!
    updatePurchaseSection(id: ID!, name: String, sortOrder: Int): PurchaseSection!
    deletePurchaseSection(id: ID!): Boolean!
    reorderPurchaseSections(purchaseId: ID!, orderedIds: [ID!]!): [PurchaseSection!]!

    createPurchaseItem(
      purchaseId: ID!
      sectionId: ID
      variantId: ID
      description: String
      qtyOrdered: Float!
      unitCostMinor: Float!
      sortOrder: Int
    ): PurchaseItem!
    updatePurchaseItem(
      id: ID!
      sectionId: ID
      variantId: ID
      description: String
      qtyOrdered: Float
      unitCostMinor: Float
      sortOrder: Int
    ): PurchaseItem!
    deletePurchaseItem(id: ID!): Boolean!
    reorderPurchaseItems(purchaseId: ID!, orderedIds: [ID!]!): [PurchaseItem!]!

    "Log that a purchase order was sent to the vendor. Append-only."
    recordPurchaseSend(
      purchaseId: ID!
      channel: PurchaseSendChannel!
      recipient: String!
      note: String
    ): PurchaseSend!
  }
`;

/** Map a PurchaseError to a GraphQLError; rethrow anything unexpected. */
function asGraphQLError(e: unknown): never {
  if (e instanceof purchases.PurchaseError) {
    throw new GraphQLError(e.message, { extensions: { code: e.code } });
  }
  throw e;
}

const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

type PurchaseRow = Awaited<ReturnType<typeof purchases.getPurchase>>;

export const resolvers = {
  Purchase: {
    createdAt: (p: PurchaseRow) => iso(p.createdAt),
    updatedAt: (p: PurchaseRow) => iso(p.updatedAt),
    lastSentAt: (p: PurchaseRow) => iso(p.lastSentAt),
    cancelledAt: (p: PurchaseRow) => iso(p.cancelledAt),
    vendor: (p: PurchaseRow) =>
      p.vendorId ? vendors.getVendor(p.vendorId) : null,
    sections: (p: PurchaseRow) => purchases.listSections(p.id),
    items: (p: PurchaseRow) => purchases.listItems(p.id),
    sends: (p: PurchaseRow) => purchases.listSends(p.id),
    totalInvoiceCost: (p: PurchaseRow) => purchases.invoiceTotalMinor(p.id),
    hasUnsentChanges: async (p: PurchaseRow) => {
      const sends = await purchases.listSends(p.id);
      const lastSentRevision = sends.reduce((max, s) => Math.max(max, s.revision), 0);
      return p.revision > lastSentRevision;
    },
  },
  PurchaseSection: {
    items: (s: { id: string }) => purchases.listSectionItems(s.id),
  },
  PurchaseSend: {
    createdAt: (s: { createdAt: Date | string }) => iso(s.createdAt),
    sentAt: (s: { sentAt: Date | string | null }) => iso(s.sentAt),
  },

  Query: {
    purchases: async (
      _: unknown,
      args: {
        status?: PurchaseRow["status"];
        vendorId?: string | null;
        includeCancelled?: boolean;
      },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "purchase.edit");
      return purchases.listPurchases({
        status: args.status,
        ...(args.vendorId !== undefined && { vendorId: args.vendorId }),
        includeCancelled: args.includeCancelled ?? false,
      });
    },
    purchase: async (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
      await requirePermission(ctx, "purchase.edit");
      try {
        return await purchases.getPurchase(args.id);
      } catch (e) {
        if (e instanceof purchases.PurchaseError && e.code === "PURCHASE_NOT_FOUND") {
          return null;
        }
        asGraphQLError(e);
      }
    },
  },

  Mutation: {
    createPurchase: async (
      _: unknown,
      args: Record<string, unknown>,
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "purchase.create");
      try {
        return await purchases.createPurchase({
          ...args,
          createdByUserId: viewer.userId,
        } as Parameters<typeof purchases.createPurchase>[0]);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    updatePurchase: async (
      _: unknown,
      args: { id: string } & Record<string, unknown>,
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "purchase.edit");
      const { id, ...patch } = args;
      try {
        return await purchases.updatePurchase(id, patch as never);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    cancelPurchase: async (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
      const viewer = await requirePermission(ctx, "purchase.cancel");
      try {
        return await purchases.cancelPurchase(args.id, viewer.userId);
      } catch (e) {
        asGraphQLError(e);
      }
    },

    createPurchaseSection: async (
      _: unknown,
      args: { purchaseId: string; name: string; sortOrder?: number },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "purchase.edit");
      try {
        return await purchases.createSection(args);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    updatePurchaseSection: async (
      _: unknown,
      args: { id: string; name?: string; sortOrder?: number },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "purchase.edit");
      const { id, ...patch } = args;
      try {
        return await purchases.updateSection(id, patch);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    deletePurchaseSection: async (
      _: unknown,
      args: { id: string },
      ctx: GraphQLContext,
    ): Promise<boolean> => {
      await requirePermission(ctx, "purchase.edit");
      try {
        await purchases.deleteSection(args.id);
        return true;
      } catch (e) {
        asGraphQLError(e);
      }
    },
    reorderPurchaseSections: async (
      _: unknown,
      args: { purchaseId: string; orderedIds: string[] },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "purchase.edit");
      try {
        return await purchases.reorderSections(args.purchaseId, args.orderedIds);
      } catch (e) {
        asGraphQLError(e);
      }
    },

    createPurchaseItem: async (
      _: unknown,
      args: Record<string, unknown>,
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "purchase.edit");
      try {
        return await purchases.createItem(
          args as Parameters<typeof purchases.createItem>[0],
        );
      } catch (e) {
        asGraphQLError(e);
      }
    },
    updatePurchaseItem: async (
      _: unknown,
      args: { id: string } & Record<string, unknown>,
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "purchase.edit");
      const { id, ...patch } = args;
      try {
        return await purchases.updateItem(id, patch as never);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    deletePurchaseItem: async (
      _: unknown,
      args: { id: string },
      ctx: GraphQLContext,
    ): Promise<boolean> => {
      await requirePermission(ctx, "purchase.edit");
      try {
        await purchases.deleteItem(args.id);
        return true;
      } catch (e) {
        asGraphQLError(e);
      }
    },
    reorderPurchaseItems: async (
      _: unknown,
      args: { purchaseId: string; orderedIds: string[] },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "purchase.edit");
      try {
        return await purchases.reorderItems(args.purchaseId, args.orderedIds);
      } catch (e) {
        asGraphQLError(e);
      }
    },

    recordPurchaseSend: async (
      _: unknown,
      args: {
        purchaseId: string;
        channel: "whatsapp" | "email" | "manual";
        recipient: string;
        note?: string | null;
      },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "purchase.send");
      try {
        return await purchases.recordPurchaseSend({
          purchaseId: args.purchaseId,
          channel: args.channel,
          recipient: args.recipient,
          note: args.note ?? null,
          createdByUserId: viewer.userId,
        });
      } catch (e) {
        asGraphQLError(e);
      }
    },
  },
};
