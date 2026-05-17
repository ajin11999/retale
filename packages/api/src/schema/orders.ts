// Orders GraphQL domain. Stage 1: the atomic POS sale (`createPosOrder`) plus
// order/line/payment queries. Console customer sales and returns come later.
// Money is Float (integer minor units; Float is exact past 2^31).

import { GraphQLError } from "graphql";
import { requirePermission } from "../lib/authz.ts";
import type { GraphQLContext } from "../lib/context.ts";
import * as orders from "../services/order-service.ts";

export const typeDefs = /* GraphQL */ `
  enum OrderStatus { open closed cancelled }
  enum OrderPaymentMethod { cash }

  type Order {
    id: ID!
    displayNumber: String
    status: OrderStatus!
    customerId: ID
    snapshotCustomerName: String
    posSessionId: ID
    "Cached order total, minor units."
    totalMinor: Float!
    closedAt: String
    cancelledAt: String
    cancellationReason: String
    returnOfOrderId: ID
    createdAt: String!
    items: [OrderItem!]!
    payments: [OrderPayment!]!
  }

  type OrderItem {
    id: ID!
    orderId: ID!
    variantId: ID
    productId: ID
    qty: Float!
    discountMinor: Float!
    snapshotProductName: String!
    snapshotProductSku: String!
    snapshotProductBarcode: String
    snapshotVariantLabel: String
    snapshotUnit: String!
    snapshotCategoryName: String
    snapshotPriceMinor: Float!
    snapshotCostMinor: Float!
    snapshotTaxRateBps: Int!
    snapshotPriceMode: String!
    "qty * price - discount."
    lineTotalMinor: Float!
    voidedAt: String
    voidReason: String
  }

  type OrderPayment {
    id: ID!
    orderId: ID!
    method: OrderPaymentMethod!
    amountMinor: Float!
    posSessionId: ID
    createdAt: String!
  }

  input PosOrderItemInput {
    variantId: ID!
    qty: Int!
    discountMinor: Float
    "Allowed only on service products."
    priceOverrideMinor: Float
  }

  input PosOrderPaymentInput {
    method: OrderPaymentMethod
    amountMinor: Float!
  }

  extend type Query {
    order(id: ID!): Order
    orders(posSessionId: ID, customerId: ID, limit: Int): [Order!]!
  }

  extend type Mutation {
    "Create an atomic POS order — closed on create against an open POS session."
    createPosOrder(
      posSessionId: ID!
      customerId: ID
      items: [PosOrderItemInput!]!
      payments: [PosOrderPaymentInput!]!
    ): Order!

    "Open an empty Console customer sale (stateful, root-only)."
    createCustomerSale(customerId: ID!): Order!
    "Add a line to an open Console sale."
    addCustomerSaleItem(orderId: ID!, item: PosOrderItemInput!): Order!
    "Void a line on an open Console sale — returns stock, reverses the ledger."
    voidCustomerSaleItem(orderItemId: ID!, reason: String!): Order!
    "Record a payment against an open Console sale."
    addCustomerSalePayment(orderId: ID!, amountMinor: Float!, posSessionId: ID): Order!
    "Close a Console sale — assigns its display number; immutable after."
    closeCustomerSale(orderId: ID!): Order!
    "Cancel an open Console sale — voids every line. reason is required."
    cancelCustomerSale(orderId: ID!, reason: String!): Order!
    "Reassign an open Console sale to a different customer (root-only)."
    changeCustomerSaleCustomer(orderId: ID!, newCustomerId: ID!): Order!
  }
`;

/** Map an OrderError to a GraphQLError; rethrow anything unexpected. */
function asGraphQLError(e: unknown): never {
  if (e instanceof orders.OrderError) {
    throw new GraphQLError(e.message, { extensions: { code: e.code } });
  }
  throw e;
}

const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

type OrderRow = Awaited<ReturnType<typeof orders.getOrder>>;
type ItemRow = Awaited<ReturnType<typeof orders.listOrderItems>>[number];

export const resolvers = {
  Order: {
    status: (o: OrderRow) => orders.orderStatus(o),
    closedAt: (o: { closedAt: Date | string | null }) => iso(o.closedAt),
    cancelledAt: (o: { cancelledAt: Date | string | null }) => iso(o.cancelledAt),
    createdAt: (o: { createdAt: Date | string }) => iso(o.createdAt),
    items: (o: { id: string }) => orders.listOrderItems(o.id),
    payments: (o: { id: string }) => orders.listOrderPayments(o.id),
  },
  OrderItem: {
    lineTotalMinor: (i: ItemRow) =>
      i.qty * i.snapshotPriceMinor - i.discountMinor,
    voidedAt: (i: { voidedAt: Date | string | null }) => iso(i.voidedAt),
  },
  OrderPayment: {
    createdAt: (p: { createdAt: Date | string }) => iso(p.createdAt),
  },

  Query: {
    order: async (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
      await requirePermission(ctx, "report.sales.view");
      try {
        return await orders.getOrder(args.id);
      } catch (e) {
        if (e instanceof orders.OrderError && e.code === "ORDER_NOT_FOUND") {
          return null;
        }
        asGraphQLError(e);
      }
    },
    orders: async (
      _: unknown,
      args: { posSessionId?: string; customerId?: string; limit?: number },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "report.sales.view");
      return orders.listOrders(args);
    },
  },

  Mutation: {
    createPosOrder: async (
      _: unknown,
      args: {
        posSessionId: string;
        customerId?: string | null;
        items: orders.PosOrderItemInput[];
        payments: orders.PosOrderPaymentInput[];
      },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "order.create_pos");
      try {
        return await orders.createPosOrder({
          posSessionId: args.posSessionId,
          customerId: args.customerId ?? null,
          items: args.items,
          payments: args.payments,
          createdByUserId: viewer.userId,
        });
      } catch (e) {
        asGraphQLError(e);
      }
    },

    createCustomerSale: async (
      _: unknown,
      args: { customerId: string },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "order.create_customer_sale");
      try {
        return await orders.createCustomerSale({
          customerId: args.customerId,
          createdByUserId: viewer.userId,
        });
      } catch (e) {
        asGraphQLError(e);
      }
    },
    addCustomerSaleItem: async (
      _: unknown,
      args: { orderId: string; item: orders.PosOrderItemInput },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "order.edit_customer_sale");
      try {
        return await orders.addCustomerSaleItem({
          orderId: args.orderId,
          item: args.item,
          createdByUserId: viewer.userId,
        });
      } catch (e) {
        asGraphQLError(e);
      }
    },
    voidCustomerSaleItem: async (
      _: unknown,
      args: { orderItemId: string; reason: string },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "order.void_item");
      try {
        return await orders.voidCustomerSaleItem({
          orderItemId: args.orderItemId,
          reason: args.reason,
          voidedByUserId: viewer.userId,
        });
      } catch (e) {
        asGraphQLError(e);
      }
    },
    addCustomerSalePayment: async (
      _: unknown,
      args: { orderId: string; amountMinor: number; posSessionId?: string | null },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "order.edit_customer_sale");
      try {
        return await orders.addCustomerSalePayment({
          orderId: args.orderId,
          amountMinor: args.amountMinor,
          posSessionId: args.posSessionId ?? null,
          createdByUserId: viewer.userId,
        });
      } catch (e) {
        asGraphQLError(e);
      }
    },
    closeCustomerSale: async (
      _: unknown,
      args: { orderId: string },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "order.close_customer_sale");
      try {
        return await orders.closeCustomerSale({
          orderId: args.orderId,
          closedByUserId: viewer.userId,
        });
      } catch (e) {
        asGraphQLError(e);
      }
    },
    cancelCustomerSale: async (
      _: unknown,
      args: { orderId: string; reason: string },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "order.cancel_customer_sale");
      try {
        return await orders.cancelCustomerSale({
          orderId: args.orderId,
          reason: args.reason,
          cancelledByUserId: viewer.userId,
        });
      } catch (e) {
        asGraphQLError(e);
      }
    },
    changeCustomerSaleCustomer: async (
      _: unknown,
      args: { orderId: string; newCustomerId: string },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "order.change_customer");
      try {
        return await orders.changeCustomerSaleCustomer({
          orderId: args.orderId,
          newCustomerId: args.newCustomerId,
          changedByUserId: viewer.userId,
        });
      } catch (e) {
        asGraphQLError(e);
      }
    },
  },
};
