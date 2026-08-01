import { requirePermission } from "../lib/authz.ts";
import type { GraphQLContext } from "../lib/context.ts";
import * as requisitions from "../services/requisition-service.ts";

export const typeDefs = /* GraphQL */ `
  enum RequisitionStatus { draft open partially_ordered fully_ordered cancelled }

  type PurchaseRequisition {
    id: ID!
    name: String!
    status: RequisitionStatus!
    createdByUserId: ID!
    createdAt: String!
    updatedAt: String!
    sections: [PurchaseRequisitionSection!]!
    items: [PurchaseRequisitionItem!]!
  }

  type PurchaseRequisitionSection {
    id: ID!
    requisitionId: ID!
    name: String!
    sortOrder: Int!
    items: [PurchaseRequisitionItem!]!
  }

  type PurchaseRequisitionItem {
    id: ID!
    requisitionId: ID!
    sectionId: ID
    variantId: ID
    description: String
    qtyRequested: Float!
    qtyOrdered: Float!
    estimatedUnitCostMinor: Float!
    sortOrder: Int!
  }

  extend type Query {
    requisitions(status: RequisitionStatus, includeCancelled: Boolean): [PurchaseRequisition!]!
    requisition(id: ID!): PurchaseRequisition
  }

  extend type Mutation {
    createRequisition(name: String!): PurchaseRequisition!
    updateRequisition(id: ID!, name: String, status: RequisitionStatus): PurchaseRequisition!
    deleteRequisition(id: ID!): Boolean!

    createRequisitionSection(requisitionId: ID!, name: String!): PurchaseRequisitionSection!
    updateRequisitionSection(id: ID!, name: String!): PurchaseRequisitionSection!
    deleteRequisitionSection(id: ID!): Boolean!
    reorderRequisitionSections(requisitionId: ID!, orderedIds: [ID!]!): [PurchaseRequisitionSection!]!

    createRequisitionItem(
      requisitionId: ID!
      sectionId: ID
      variantId: ID
      description: String
      qtyRequested: Float!
      estimatedUnitCostMinor: Float
    ): PurchaseRequisitionItem!
    updateRequisitionItem(
      id: ID!
      sectionId: ID
      variantId: ID
      description: String
      qtyRequested: Float
      estimatedUnitCostMinor: Float
    ): PurchaseRequisitionItem!
    deleteRequisitionItem(id: ID!): Boolean!
    reorderRequisitionItems(requisitionId: ID!, orderedIds: [ID!]!): [PurchaseRequisitionItem!]!
  }
`;

export const resolvers = {
  PurchaseRequisition: {
    sections: (parent: any) => requisitions.listSections(parent.id),
    items: (parent: any) => requisitions.listItems(parent.id),
  },
  PurchaseRequisitionSection: {
    items: (parent: any) => requisitions.listSectionItems(parent.id),
  },
  Query: {
    requisitions: async (_: any, args: any, ctx: GraphQLContext) => {
      // Basic access check for viewing purchases/requisitions
      await requirePermission(ctx, "purchase.edit");
      return requisitions.listRequisitions(args);
    },
    requisition: async (_: any, { id }: any, ctx: GraphQLContext) => {
      await requirePermission(ctx, "purchase.edit");
      try {
        return await requisitions.getRequisition(id);
      } catch (e: any) {
        if (e.code === "REQUISITION_NOT_FOUND") return null;
        throw e;
      }
    },
  },
  Mutation: {
    createRequisition: async (_: any, args: any, ctx: GraphQLContext) => {
      const viewer = await requirePermission(ctx, "purchase.create");
      return requisitions.createRequisition({ ...args, createdByUserId: viewer.userId });
    },
    updateRequisition: async (_: any, args: any, ctx: GraphQLContext) => {
      await requirePermission(ctx, "purchase.edit");
      return requisitions.updateRequisition(args.id, args);
    },
    deleteRequisition: async (_: any, { id }: any, ctx: GraphQLContext) => {
      await requirePermission(ctx, "purchase.edit");
      await requisitions.deleteRequisition(id);
      return true;
    },
    createRequisitionSection: async (_: any, args: any, ctx: GraphQLContext) => {
      await requirePermission(ctx, "purchase.edit");
      return requisitions.createSection(args.requisitionId, args.name);
    },
    updateRequisitionSection: async (_: any, args: any, ctx: GraphQLContext) => {
      await requirePermission(ctx, "purchase.edit");
      return requisitions.updateSection(args.id, args.name);
    },
    deleteRequisitionSection: async (_: any, { id }: any, ctx: GraphQLContext) => {
      await requirePermission(ctx, "purchase.edit");
      await requisitions.deleteSection(id);
      return true;
    },
    reorderRequisitionSections: async (_: any, args: any, ctx: GraphQLContext) => {
      await requirePermission(ctx, "purchase.edit");
      return requisitions.reorderSections(args.requisitionId, args.orderedIds);
    },
    createRequisitionItem: async (_: any, args: any, ctx: GraphQLContext) => {
      await requirePermission(ctx, "purchase.edit");
      return requisitions.createItem(args);
    },
    updateRequisitionItem: async (_: any, args: any, ctx: GraphQLContext) => {
      await requirePermission(ctx, "purchase.edit");
      return requisitions.updateItem(args.id, args);
    },
    deleteRequisitionItem: async (_: any, { id }: any, ctx: GraphQLContext) => {
      await requirePermission(ctx, "purchase.edit");
      await requisitions.deleteItem(id);
      return true;
    },
    reorderRequisitionItems: async (_: any, args: any, ctx: GraphQLContext) => {
      await requirePermission(ctx, "purchase.edit");
      return requisitions.reorderItems(args.requisitionId, args.orderedIds);
    },
  },
};
