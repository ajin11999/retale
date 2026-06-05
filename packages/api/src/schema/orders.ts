// Orders GraphQL domain. Stage 1: the atomic POS sale (`createPosOrder`) plus
// order/line/payment queries. Console customer sales and returns come later.
// Money is Float (integer minor units; Float is exact past 2^31).

import { GraphQLError } from "graphql";
import { requirePermission } from "../lib/authz.ts";
import type { GraphQLContext } from "../lib/context.ts";
import { getCustomer } from "../services/customer-service.ts";
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
    "Free-text note on a Console customer sale (editable while open)."
    note: String
    returnOfOrderId: ID
    createdAt: String!
    items: [OrderItem!]!
    payments: [OrderPayment!]!
    "Live contact details of the attached customer, for sending a receipt. Null when no customer is attached or the customer was deleted."
    customer: OrderCustomer
  }

  "The subset of customer fields a receipt needs. Readable wherever the order is."
  type OrderCustomer {
    id: ID!
    name: String!
    phone: String
  }

  type OrderItem {
    id: ID!
    orderId: ID!
    variantId: ID
    productId: ID
    qty: Float!
    discountMinor: Float!
    snapshotProductName: String!
    "Public name at sale time, if any."
    snapshotPublicName: String
    "If this line came from a bundle, the bundle's name at sale time."
    snapshotBundleName: String
    "snapshotPublicName ?? snapshotProductName — the name for a receipt."
    displayName: String!
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
    "Tracking account this line attributes revenue to, if any."
    attributionAccountId: ID
    "Attributed amount, minor units (pre-tax revenue share)."
    attributionAmountMinor: Float!
    voidedAt: String
    voidReason: String
    "The live variant behind this line (null after a hard-delete). Carries current totalQty."
    variant: ProductVariant
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
    "Cashier-entered price override. Optional on any line; required on open-price products."
    priceOverrideMinor: Float
    "Overrides the computed tracking attribution; requires order.attribute."
    attributionAmountOverrideMinor: Float
  }

  input PosOrderPaymentInput {
    method: OrderPaymentMethod
    amountMinor: Float!
  }

  enum RefundMethod { cash store_credit }

  input ReturnItemInput {
    "The original order_item being returned."
    orderItemId: ID!
    "Units to return — positive."
    qty: Int!
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
    createCustomerSale(customerId: ID!, note: String): Order!
    """
    Set or clear the free-text note on an open Console sale. Pass an empty
    string to clear; null leaves it unchanged.
    """
    updateCustomerSaleNote(orderId: ID!, note: String): Order!
    "Add a line to an open Console sale."
    addCustomerSaleItem(orderId: ID!, item: PosOrderItemInput!): Order!
    """
    Edit a non-voided line on an open Console sale. Each field is optional;
    omitted fields are left untouched. displayNameOverride writes the line's
    receipt name (empty string clears it back to the default).
    """
    updateCustomerSaleItem(
      orderItemId: ID!
      qty: Int
      discountMinor: Float
      priceOverrideMinor: Float
      displayNameOverride: String
    ): Order!
    "Void (delete) a line on an open Console sale — returns stock. Reason is optional."
    voidCustomerSaleItem(orderItemId: ID!, reason: String): Order!
    "Record a payment against an open Console sale."
    addCustomerSalePayment(orderId: ID!, amountMinor: Float!, posSessionId: ID): Order!
    "Close a Console sale — assigns its display number; immutable after."
    closeCustomerSale(orderId: ID!): Order!
    "Cancel an open Console sale — voids every line. reason is required."
    cancelCustomerSale(orderId: ID!, reason: String!): Order!
    "Reassign an open Console sale to a different customer (root-only)."
    changeCustomerSaleCustomer(orderId: ID!, newCustomerId: ID!): Order!

    "Create a return order against a closed original. Refund as cash or store credit."
    createReturn(
      originalOrderId: ID!
      posSessionId: ID!
      items: [ReturnItemInput!]!
      refundMethod: RefundMethod!
    ): Order!
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
    customer: async (o: { customerId: string | null }) => {
      if (!o.customerId) return null;
      // A hard-deleted customer leaves the snapshot name on the order but no
      // live row — return null rather than surfacing the error.
      try {
        return await getCustomer(o.customerId);
      } catch {
        return null;
      }
    },
  },
  OrderItem: {
    lineTotalMinor: (i: ItemRow) =>
      i.qty * i.snapshotPriceMinor - i.discountMinor,
    displayName: (i: ItemRow) => i.snapshotPublicName ?? i.snapshotProductName,
    voidedAt: (i: { voidedAt: Date | string | null }) => iso(i.voidedAt),
    variant: (i: { variantId: string | null }) =>
      i.variantId ? orders.getLineVariant(i.variantId) : null,
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
      if (args.items.some((i) => i.attributionAmountOverrideMinor != null)) {
        await requirePermission(ctx, "order.attribute");
      }
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
      args: { customerId: string; note?: string | null },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "order.create_customer_sale");
      try {
        return await orders.createCustomerSale({
          customerId: args.customerId,
          note: args.note ?? null,
          createdByUserId: viewer.userId,
        });
      } catch (e) {
        asGraphQLError(e);
      }
    },
    updateCustomerSaleNote: async (
      _: unknown,
      args: { orderId: string; note?: string | null },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "order.edit_customer_sale");
      try {
        return await orders.updateCustomerSaleNote({
          orderId: args.orderId,
          note: args.note ?? null,
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
      if (args.item.attributionAmountOverrideMinor != null) {
        await requirePermission(ctx, "order.attribute");
      }
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
    updateCustomerSaleItem: async (
      _: unknown,
      args: {
        orderItemId: string;
        qty?: number | null;
        discountMinor?: number | null;
        priceOverrideMinor?: number | null;
        displayNameOverride?: string | null;
      },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "order.edit_customer_sale");
      try {
        return await orders.updateCustomerSaleItem({
          orderItemId: args.orderItemId,
          qty: args.qty ?? null,
          discountMinor: args.discountMinor ?? null,
          priceOverrideMinor: args.priceOverrideMinor ?? null,
          // Distinguish "field omitted" from "explicit empty string". Houdini /
          // graphql-yoga gives us `undefined` for the former and `""` for the
          // latter, which the service layer interprets as "clear".
          displayNameOverride:
            args.displayNameOverride === undefined
              ? undefined
              : args.displayNameOverride,
          updatedByUserId: viewer.userId,
        });
      } catch (e) {
        asGraphQLError(e);
      }
    },
    voidCustomerSaleItem: async (
      _: unknown,
      args: { orderItemId: string; reason?: string | null },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "order.void_item");
      try {
        return await orders.voidCustomerSaleItem({
          orderItemId: args.orderItemId,
          reason: args.reason ?? null,
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
    createReturn: async (
      _: unknown,
      args: {
        originalOrderId: string;
        posSessionId: string;
        items: orders.ReturnItemInput[];
        refundMethod: "cash" | "store_credit";
      },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "order.refund");
      try {
        return await orders.createReturn({
          originalOrderId: args.originalOrderId,
          posSessionId: args.posSessionId,
          items: args.items,
          refundMethod: args.refundMethod,
          createdByUserId: viewer.userId,
        });
      } catch (e) {
        asGraphQLError(e);
      }
    },
  },
};
