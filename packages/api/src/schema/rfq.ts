import { requirePermission } from "../lib/authz.ts";
import type { GraphQLContext } from "../lib/context.ts";
import * as rfqService from "../services/rfq-service.ts";

export const typeDefs = /* GraphQL */ `
  enum RfqStatus { draft sent received awarded cancelled }

  type RequestForQuotation {
    id: ID!
    rfqNumber: String!
    vendorId: ID
    snapshotVendorName: String!
    date: String!
    dueDate: String
    status: RfqStatus!
    memo: String
    termsAndConditions: String
    createdByUserId: ID
    createdAt: String!
    updatedAt: String!
    sections: [RfqSection!]!
    items: [RfqItem!]!
  }

  type RfqSection {
    id: ID!
    rfqId: ID!
    name: String!
    sortOrder: Int!
    items: [RfqItem!]!
  }

  type RfqItem {
    id: ID!
    rfqId: ID!
    sectionId: ID
    requisitionItemId: ID
    variantId: ID
    description: String
    qtyRequested: Float!
    targetUnitCostMinor: Float!
    quotedUnitCostMinor: Float!
    sortOrder: Int!
  }

  extend type Query {
    rfqs(status: RfqStatus): [RequestForQuotation!]!
    rfq(id: ID!): RequestForQuotation
  }

  extend type Mutation {
    createRfq(
      vendorId: ID
      date: String!
      dueDate: String
      memo: String
      termsAndConditions: String
    ): RequestForQuotation!

    createRfqFromRequisitions(
      vendorId: ID
      date: String!
      dueDate: String
      memo: String
      termsAndConditions: String
      requisitionItemIds: [ID!]!
    ): RequestForQuotation!

    updateRfq(
      id: ID!
      vendorId: ID
      date: String
      dueDate: String
      status: RfqStatus
      memo: String
      termsAndConditions: String
    ): RequestForQuotation!

    deleteRfq(id: ID!): Boolean!

    createRfqSection(rfqId: ID!, name: String!): RfqSection!
    updateRfqSection(id: ID!, name: String!): RfqSection!
    deleteRfqSection(id: ID!): Boolean!
    reorderRfqSections(rfqId: ID!, orderedIds: [ID!]!): [RfqSection!]!

    createRfqItem(
      rfqId: ID!
      sectionId: ID
      requisitionItemId: ID
      variantId: ID
      description: String
      qtyRequested: Float!
      targetUnitCostMinor: Float
      quotedUnitCostMinor: Float
    ): RfqItem!

    updateRfqItem(
      id: ID!
      sectionId: ID
      variantId: ID
      description: String
      qtyRequested: Float
      targetUnitCostMinor: Float
      quotedUnitCostMinor: Float
    ): RfqItem!

    deleteRfqItem(id: ID!): Boolean!
    reorderRfqItems(rfqId: ID!, orderedIds: [ID!]!): [RfqItem!]!

    convertRfqToPurchase(rfqId: ID!, vendorId: ID): Purchase!
  }
`;

export const resolvers = {
  RequestForQuotation: {
    sections: (parent: any) => rfqService.listSections(parent.id),
    items: (parent: any) => rfqService.listItems(parent.id),
  },
  RfqSection: {
    items: (parent: any) => rfqService.listSectionItems(parent.id),
  },
  Query: {
    rfqs: async (_: any, args: any, ctx: GraphQLContext) => {
      await requirePermission(ctx, "purchase.edit");
      return rfqService.listRfqs(args);
    },
    rfq: async (_: any, { id }: any, ctx: GraphQLContext) => {
      await requirePermission(ctx, "purchase.edit");
      try {
        return await rfqService.getRfq(id);
      } catch (e: any) {
        if (e.code === "RFQ_NOT_FOUND") return null;
        throw e;
      }
    },
  },
  Mutation: {
    createRfq: async (_: any, args: any, ctx: GraphQLContext) => {
      const viewer = await requirePermission(ctx, "purchase.create");
      return rfqService.createRfq({ ...args, createdByUserId: viewer.userId });
    },
    createRfqFromRequisitions: async (_: any, args: any, ctx: GraphQLContext) => {
      const viewer = await requirePermission(ctx, "purchase.create");
      return rfqService.createRfqFromRequisitions({
        ...args,
        createdByUserId: viewer.userId,
      });
    },
    updateRfq: async (_: any, args: any, ctx: GraphQLContext) => {
      await requirePermission(ctx, "purchase.edit");
      return rfqService.updateRfq(args.id, args);
    },
    deleteRfq: async (_: any, { id }: any, ctx: GraphQLContext) => {
      await requirePermission(ctx, "purchase.edit");
      await rfqService.deleteRfq(id);
      return true;
    },
    createRfqSection: async (_: any, args: any, ctx: GraphQLContext) => {
      await requirePermission(ctx, "purchase.edit");
      return rfqService.createSection(args.rfqId, args.name);
    },
    updateRfqSection: async (_: any, args: any, ctx: GraphQLContext) => {
      await requirePermission(ctx, "purchase.edit");
      return rfqService.updateSection(args.id, args.name);
    },
    deleteRfqSection: async (_: any, { id }: any, ctx: GraphQLContext) => {
      await requirePermission(ctx, "purchase.edit");
      await rfqService.deleteSection(id);
      return true;
    },
    reorderRfqSections: async (_: any, args: any, ctx: GraphQLContext) => {
      await requirePermission(ctx, "purchase.edit");
      return rfqService.reorderSections(args.rfqId, args.orderedIds);
    },
    createRfqItem: async (_: any, args: any, ctx: GraphQLContext) => {
      await requirePermission(ctx, "purchase.edit");
      return rfqService.createItem(args);
    },
    updateRfqItem: async (_: any, args: any, ctx: GraphQLContext) => {
      await requirePermission(ctx, "purchase.edit");
      return rfqService.updateItem(args.id, args);
    },
    deleteRfqItem: async (_: any, { id }: any, ctx: GraphQLContext) => {
      await requirePermission(ctx, "purchase.edit");
      await rfqService.deleteItem(id);
      return true;
    },
    reorderRfqItems: async (_: any, args: any, ctx: GraphQLContext) => {
      await requirePermission(ctx, "purchase.edit");
      return rfqService.reorderItems(args.rfqId, args.orderedIds);
    },
    convertRfqToPurchase: async (_: any, args: any, ctx: GraphQLContext) => {
      const viewer = await requirePermission(ctx, "purchase.create");
      return rfqService.convertRfqToPurchase({
        rfqId: args.rfqId,
        vendorId: args.vendorId,
        createdByUserId: viewer.userId,
      });
    },
  },
};
