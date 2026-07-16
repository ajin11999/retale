// Stock transfer service: the draft → dispatch → receive lifecycle for moving
// stock between locations, plus cancellation. Stock moves through the
// `stock_movements` ledger via the stock service — `transfer_out` debits the
// source on dispatch, `transfer_in` credits the target on receive. Cancelling
// an in-transit transfer returns the dispatched stock to the source.

import { desc, eq, and } from "drizzle-orm";
import { ulid } from "ulid";
import { locations } from "../db/schema/locations.ts";
import { productVariants } from "../db/schema/products.ts";
import {
  stockTransferItems,
  stockTransfers,
} from "../db/schema/transfers.ts";
import { db } from "../lib/db.ts";
import { recordMovement } from "./stock-service.ts";

export type TransferErrorCode =
  | "TRANSFER_NOT_FOUND"
  | "LOCATION_NOT_FOUND"
  | "VARIANT_NOT_FOUND"
  | "INVALID_INPUT"
  | "SAME_LOCATION"
  | "EMPTY_TRANSFER"
  | "NOT_DRAFT"
  | "NOT_IN_TRANSIT"
  | "ALREADY_RECEIVED";

export class TransferError extends Error {
  constructor(
    public code: TransferErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "TransferError";
  }
}

type Transfer = typeof stockTransfers.$inferSelect;
type TransferItem = typeof stockTransferItems.$inferSelect;

/** A drizzle transaction handle; structurally a subset of `db`. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type TransferStatus =
  | "draft"
  | "in_transit"
  | "received"
  | "cancelled";

/** Derived lifecycle status — never stored. */
export function transferStatus(t: Transfer): TransferStatus {
  if (t.cancelledAt) return "cancelled";
  if (t.receivedAt) return "received";
  if (t.dispatchedAt) return "in_transit";
  return "draft";
}

async function loadTransfer(id: string): Promise<Transfer> {
  const row = await db.query.stockTransfers.findFirst({
    where: eq(stockTransfers.id, id),
  });
  if (!row) throw new TransferError("TRANSFER_NOT_FOUND");
  return row;
}

export { loadTransfer as getTransfer };

export function listTransfers(limit = 100): Promise<Transfer[]> {
  return db
    .select()
    .from(stockTransfers)
    .orderBy(desc(stockTransfers.createdAt))
    .limit(Math.min(Math.max(limit, 1), 500));
}

export function listTransferItems(transferId: string): Promise<TransferItem[]> {
  return db
    .select()
    .from(stockTransferItems)
    .where(eq(stockTransferItems.transferId, transferId));
}

/**
 * Draft a stock transfer. Validates the locations and lines but moves no
 * stock — that happens on dispatch.
 */
export async function createTransfer(input: {
  sourceLocationId: string;
  targetLocationId: string;
  items: { variantId: string; qty: number }[];
  notes?: string | null;
  createdByUserId: string;
}): Promise<Transfer> {
  if (input.sourceLocationId === input.targetLocationId) {
    throw new TransferError("SAME_LOCATION");
  }
  if (!input.items.length) throw new TransferError("EMPTY_TRANSFER");

  return db.transaction(async (tx) => {
    for (const id of [input.sourceLocationId, input.targetLocationId]) {
      const loc = await tx.query.locations.findFirst({
        where: eq(locations.id, id),
      });
      if (!loc) throw new TransferError("LOCATION_NOT_FOUND", id);
    }
    for (const item of input.items) {
      if (!Number.isInteger(item.qty) || item.qty <= 0) {
        throw new TransferError("INVALID_INPUT", "item qty must be a positive integer");
      }
      const variant = await tx.query.productVariants.findFirst({
        where: eq(productVariants.id, item.variantId),
      });
      if (!variant) throw new TransferError("VARIANT_NOT_FOUND", item.variantId);
    }

    const transferId = ulid();
    await tx.insert(stockTransfers).values({
      id: transferId,
      sourceLocationId: input.sourceLocationId,
      targetLocationId: input.targetLocationId,
      notes: input.notes ?? null,
      createdByUserId: input.createdByUserId,
    });
    await tx.insert(stockTransferItems).values(
      input.items.map((item) => ({
        id: ulid(),
        transferId,
        variantId: item.variantId,
        qty: item.qty,
      })),
    );
    const row = await tx.query.stockTransfers.findFirst({
      where: eq(stockTransfers.id, transferId),
    });
    return row as Transfer;
  });
}

/** Move every line of a transfer through the ledger at one location. */
async function moveLines(
  tx: Tx,
  transferId: string,
  locationId: string,
  type: "transfer_out" | "transfer_in",
  sign: 1 | -1,
  createdByUserId: string,
): Promise<void> {
  const items = await tx
    .select()
    .from(stockTransferItems)
    .where(eq(stockTransferItems.transferId, transferId));
  for (const item of items) {
    await recordMovement(
      {
        variantId: item.variantId,
        locationId,
        type,
        qtyDelta: sign * item.qty,
        refType: "transfer",
        refId: transferId,
        createdByUserId,
      },
      tx,
    );
  }
}

/**
 * Dispatch a draft transfer: `transfer_out` debits the source location for
 * every line. Stock may go negative — selling/moving into negative stock is
 * allowed, consistent with the rest of the system.
 */
export async function dispatchTransfer(
  id: string,
  dispatchedByUserId: string,
): Promise<Transfer> {
  return db.transaction(async (tx) => {
    const transfer = await tx.query.stockTransfers.findFirst({
      where: eq(stockTransfers.id, id),
    });
    if (!transfer) throw new TransferError("TRANSFER_NOT_FOUND");
    if (transferStatus(transfer) !== "draft") {
      throw new TransferError("NOT_DRAFT");
    }
    await moveLines(
      tx,
      id,
      transfer.sourceLocationId,
      "transfer_out",
      -1,
      dispatchedByUserId,
    );
    await tx
      .update(stockTransfers)
      .set({ dispatchedAt: new Date(), dispatchedByUserId })
      .where(eq(stockTransfers.id, id));
    const row = await tx.query.stockTransfers.findFirst({
      where: eq(stockTransfers.id, id),
    });
    return row as Transfer;
  });
}

/**
 * Receive an in-transit transfer: `transfer_in` credits the target location
 * for every line, completing the move.
 */
export async function receiveTransfer(
  id: string,
  receivedByUserId: string,
): Promise<Transfer> {
  return db.transaction(async (tx) => {
    const transfer = await tx.query.stockTransfers.findFirst({
      where: eq(stockTransfers.id, id),
    });
    if (!transfer) throw new TransferError("TRANSFER_NOT_FOUND");
    if (transferStatus(transfer) !== "in_transit") {
      throw new TransferError("NOT_IN_TRANSIT");
    }
    await moveLines(
      tx,
      id,
      transfer.targetLocationId,
      "transfer_in",
      1,
      receivedByUserId,
    );
    await tx
      .update(stockTransfers)
      .set({ receivedAt: new Date(), receivedByUserId })
      .where(eq(stockTransfers.id, id));
    const row = await tx.query.stockTransfers.findFirst({
      where: eq(stockTransfers.id, id),
    });
    return row as Transfer;
  });
}

/**
 * Cancel a transfer. A draft is cancelled outright; an in-transit transfer
 * has its dispatched stock returned to the source (`transfer_in` at source).
 * A received transfer cannot be cancelled — reverse it with a new transfer.
 */
export async function cancelTransfer(
  id: string,
  reason: string,
  cancelledByUserId: string,
): Promise<Transfer> {
  if (!reason.trim()) {
    throw new TransferError("INVALID_INPUT", "cancellation reason is required");
  }
  return db.transaction(async (tx) => {
    const transfer = await tx.query.stockTransfers.findFirst({
      where: eq(stockTransfers.id, id),
    });
    if (!transfer) throw new TransferError("TRANSFER_NOT_FOUND");
    const status = transferStatus(transfer);
    if (status === "received") throw new TransferError("ALREADY_RECEIVED");
    if (status === "cancelled") return transfer;

    if (status === "in_transit") {
      // Stock already left the source — put it back.
      await moveLines(
        tx,
        id,
        transfer.sourceLocationId,
        "transfer_in",
        1,
        cancelledByUserId,
      );
    }
    await tx
      .update(stockTransfers)
      .set({
        cancelledAt: new Date(),
        cancelledByUserId,
        cancellationReason: reason.trim(),
      })
      .where(eq(stockTransfers.id, id));
    const row = await tx.query.stockTransfers.findFirst({
      where: eq(stockTransfers.id, id),
    });
    return row as Transfer;
  });
}

/** Add lines to a draft transfer. Combines quantities if variant already exists. */
export async function addTransferItems(
  id: string,
  items: { variantId: string; qty: number }[],
): Promise<Transfer> {
  if (!items.length) throw new TransferError("EMPTY_TRANSFER");
  
  return db.transaction(async (tx) => {
    const transfer = await tx.query.stockTransfers.findFirst({
      where: eq(stockTransfers.id, id),
    });
    if (!transfer) throw new TransferError("TRANSFER_NOT_FOUND");
    if (transferStatus(transfer) !== "draft") {
      throw new TransferError("NOT_DRAFT", "can only add items to a draft transfer");
    }

    for (const item of items) {
      if (!Number.isInteger(item.qty) || item.qty <= 0) {
        throw new TransferError("INVALID_INPUT", "item qty must be a positive integer");
      }
      const variant = await tx.query.productVariants.findFirst({
        where: eq(productVariants.id, item.variantId),
      });
      if (!variant) throw new TransferError("VARIANT_NOT_FOUND", item.variantId);
    }

    for (const item of items) {
      const existing = await tx.query.stockTransferItems.findFirst({
        where: and(
          eq(stockTransferItems.transferId, id),
          eq(stockTransferItems.variantId, item.variantId)
        )
      });
      if (existing) {
        await tx.update(stockTransferItems)
          .set({ qty: existing.qty + item.qty })
          .where(eq(stockTransferItems.id, existing.id));
      } else {
        await tx.insert(stockTransferItems).values({
          id: ulid(),
          transferId: id,
          variantId: item.variantId,
          qty: item.qty,
        });
      }
    }

    return transfer;
  });
}

/** Remove a line from a draft transfer. */
export async function removeTransferItem(
  id: string,
  itemId: string,
): Promise<Transfer> {
  return db.transaction(async (tx) => {
    const transfer = await tx.query.stockTransfers.findFirst({
      where: eq(stockTransfers.id, id),
    });
    if (!transfer) throw new TransferError("TRANSFER_NOT_FOUND");
    if (transferStatus(transfer) !== "draft") {
      throw new TransferError("NOT_DRAFT", "can only remove items from a draft transfer");
    }

    const item = await tx.query.stockTransferItems.findFirst({
      where: eq(stockTransferItems.id, itemId),
    });
    if (!item || item.transferId !== id) {
      throw new TransferError("INVALID_INPUT", "item not found in this transfer");
    }

    await tx.delete(stockTransferItems).where(eq(stockTransferItems.id, itemId));

    return transfer;
  });
}
