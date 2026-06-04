// Customers GraphQL domain: customer CRUD, archive, root-only credit limit,
// root-only hard delete, the two AR ledger writers (record debt payment,
// adjust balance), and per-customer variant price overrides. Money is Float
// (integer minor units; Float is exact past 2^31).

import { GraphQLError } from "graphql";
import { requirePermission } from "../lib/authz.ts";
import type { GraphQLContext } from "../lib/context.ts";
import * as customers from "../services/customer-service.ts";

export const typeDefs = /* GraphQL */ `
  enum CustomerLedgerType {
    sale_on_account
    payment
    refund_credit
    adjustment
    opening_balance
  }

  enum CustomerLedgerRefType { order order_item payment refund adjustment import }

  type Customer {
    id: ID!
    name: String!
    phone: String
    email: String
    address: String
    notes: String
    "Cached AR balance, minor units. Positive = the customer owes us."
    balanceMinor: Float!
    "Credit limit in minor units. Null = no limit."
    creditLimitMinor: Float
    archivedAt: String
    createdAt: String!
    updatedAt: String!
  }

  type CustomerLedgerEntry {
    id: ID!
    customerId: ID!
    type: CustomerLedgerType!
    "Signed minor units. Positive = they owe more; negative = they owe less."
    amountMinor: Float!
    refType: CustomerLedgerRefType
    refId: ID
    note: String
    posSessionId: ID
    createdAt: String!
  }

  type CustomerPrice {
    id: ID!
    customerId: ID!
    variantId: ID!
    priceMinor: Float!
    createdAt: String!
    updatedAt: String!
  }

  extend type Query {
    customers(includeArchived: Boolean): [Customer!]!
    customer(id: ID!): Customer
    customerLedger(customerId: ID!, limit: Int): [CustomerLedgerEntry!]!
    customerPrices(customerId: ID!): [CustomerPrice!]!
    """
    Lightweight customer search for the POS register — matches name or phone,
    excludes archived. Gated on order.create_pos so any cashier can attach a
    customer to a sale (the broader customers query needs customer.edit).
    """
    posCustomerSearch(search: String, limit: Int): [Customer!]!
  }

  extend type Mutation {
    createCustomer(
      name: String!
      phone: String
      email: String
      address: String
      notes: String
    ): Customer!
    updateCustomer(
      id: ID!
      name: String
      phone: String
      email: String
      address: String
      notes: String
    ): Customer!
    setCustomerArchived(id: ID!, archived: Boolean!): Customer!
    "Root-only. creditLimitMinor of null clears the limit."
    setCustomerCreditLimit(id: ID!, creditLimitMinor: Float): Customer!
    "Hard delete — root-only. Refused if the customer carries a non-zero AR balance."
    hardDeleteCustomer(id: ID!): Boolean!
    "Record a cash payment against existing customer debt. amountMinor is the positive sum received."
    recordDebtPayment(
      customerId: ID!
      amountMinor: Float!
      posSessionId: ID
      note: String
    ): Customer!
    "Root-only manual balance correction. Signed amountMinor; note required."
    adjustCustomerBalance(customerId: ID!, amountMinor: Float!, note: String!): Customer!
    "Upsert a per-customer price override for a variant."
    setCustomerPrice(customerId: ID!, variantId: ID!, priceMinor: Float!): CustomerPrice!
    removeCustomerPrice(customerId: ID!, variantId: ID!): Boolean!
  }
`;

/** Map a CustomerError to a GraphQLError; rethrow anything unexpected. */
function asGraphQLError(e: unknown): never {
  if (e instanceof customers.CustomerError) {
    throw new GraphQLError(e.message, { extensions: { code: e.code } });
  }
  throw e;
}

const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

export const resolvers = {
  Customer: {
    createdAt: (c: { createdAt: Date | string }) => iso(c.createdAt),
    updatedAt: (c: { updatedAt: Date | string }) => iso(c.updatedAt),
    archivedAt: (c: { archivedAt: Date | string | null }) => iso(c.archivedAt),
  },
  CustomerLedgerEntry: {
    createdAt: (e: { createdAt: Date | string }) => iso(e.createdAt),
  },
  CustomerPrice: {
    createdAt: (p: { createdAt: Date | string }) => iso(p.createdAt),
    updatedAt: (p: { updatedAt: Date | string }) => iso(p.updatedAt),
  },

  Query: {
    customers: async (
      _: unknown,
      args: { includeArchived?: boolean },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "customer.edit");
      return customers.listCustomers(args.includeArchived ?? false);
    },
    customer: async (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
      await requirePermission(ctx, "customer.edit");
      try {
        return await customers.getCustomer(args.id);
      } catch (e) {
        if (
          e instanceof customers.CustomerError &&
          e.code === "CUSTOMER_NOT_FOUND"
        ) {
          return null;
        }
        asGraphQLError(e);
      }
    },
    customerLedger: async (
      _: unknown,
      args: { customerId: string; limit?: number },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "report.ar_aging.view");
      try {
        return await customers.listCustomerLedger(args.customerId, args.limit ?? 100);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    customerPrices: async (
      _: unknown,
      args: { customerId: string },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "customer.edit");
      try {
        return await customers.listCustomerPrices(args.customerId);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    posCustomerSearch: async (
      _: unknown,
      args: { search?: string | null; limit?: number | null },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "order.create_pos");
      return customers.searchCustomers(args.search, args.limit ?? 20);
    },
  },

  Mutation: {
    createCustomer: async (
      _: unknown,
      args: Record<string, unknown>,
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "customer.create");
      try {
        return await customers.createCustomer({
          ...args,
          createdByUserId: viewer.userId,
        } as Parameters<typeof customers.createCustomer>[0]);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    updateCustomer: async (
      _: unknown,
      args: { id: string } & Record<string, unknown>,
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "customer.edit");
      const { id, ...patch } = args;
      try {
        return await customers.updateCustomer(id, patch as never);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    setCustomerArchived: async (
      _: unknown,
      args: { id: string; archived: boolean },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "customer.archive");
      try {
        return await customers.setCustomerArchived(args.id, args.archived);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    setCustomerCreditLimit: async (
      _: unknown,
      args: { id: string; creditLimitMinor?: number | null },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "customer.set_credit_limit");
      try {
        return await customers.setCustomerCreditLimit(
          args.id,
          args.creditLimitMinor ?? null,
        );
      } catch (e) {
        asGraphQLError(e);
      }
    },
    hardDeleteCustomer: async (
      _: unknown,
      args: { id: string },
      ctx: GraphQLContext,
    ): Promise<boolean> => {
      await requirePermission(ctx, "customer.hard_delete");
      try {
        await customers.hardDeleteCustomer(args.id);
        return true;
      } catch (e) {
        asGraphQLError(e);
      }
    },
    recordDebtPayment: async (
      _: unknown,
      args: {
        customerId: string;
        amountMinor: number;
        posSessionId?: string | null;
        note?: string | null;
      },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "debt.record_payment");
      try {
        return await customers.recordDebtPayment({
          customerId: args.customerId,
          amountMinor: args.amountMinor,
          posSessionId: args.posSessionId ?? null,
          note: args.note ?? null,
          createdByUserId: viewer.userId,
        });
      } catch (e) {
        asGraphQLError(e);
      }
    },
    adjustCustomerBalance: async (
      _: unknown,
      args: { customerId: string; amountMinor: number; note: string },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "customer.adjustment");
      try {
        return await customers.adjustCustomerBalance({
          customerId: args.customerId,
          amountMinor: args.amountMinor,
          note: args.note,
          createdByUserId: viewer.userId,
        });
      } catch (e) {
        asGraphQLError(e);
      }
    },
    setCustomerPrice: async (
      _: unknown,
      args: { customerId: string; variantId: string; priceMinor: number },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "customer.edit");
      try {
        return await customers.setCustomerPrice(args);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    removeCustomerPrice: async (
      _: unknown,
      args: { customerId: string; variantId: string },
      ctx: GraphQLContext,
    ): Promise<boolean> => {
      await requirePermission(ctx, "customer.edit");
      try {
        await customers.removeCustomerPrice(args.customerId, args.variantId);
        return true;
      } catch (e) {
        asGraphQLError(e);
      }
    },
  },
};
