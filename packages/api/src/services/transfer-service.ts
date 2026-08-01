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

export async function createTransfer(input: {
  targetLocationId: string;
  items?: { variantId: string; qty: number; sourceLocationId: string }[];
  notes?: string | null;
  createdByUserId: string;
}): Promise<Transfer> {
  const items = input.items || [];
  if (items.length === 0) throw new TransferError("EMPTY_TRANSFER");

  return db.transaction(async (tx) => {
    const loc = await tx.query.locations.findFirst({
      where: eq(locations.id, input.targetLocationId),
    });
    if (!loc) throw new TransferError("LOCATION_NOT_FOUND", input.targetLocationId);

    for (const item of items) {
      if (item.sourceLocationId === input.targetLocationId) {
        throw new TransferError("SAME_LOCATION");
      }
      if (!Number.isInteger(item.qty) || item.qty <= 0) {
        throw new TransferError("INVALID_INPUT", "item qty must be a positive integer");
      }
      const sloc = await tx.query.locations.findFirst({
        where: eq(locations.id, item.sourceLocationId),
      });
      if (!sloc) throw new TransferError("LOCATION_NOT_FOUND", item.sourceLocationId);
      const variant = await tx.query.productVariants.findFirst({
        where: eq(productVariants.id, item.variantId),
      });
      if (!variant) throw new TransferError("VARIANT_NOT_FOUND", item.variantId);
    }

    const transferId = ulid();
    await tx.insert(stockTransfers).values({
      id: transferId,
      targetLocationId: input.targetLocationId,
      notes: input.notes ?? null,
      createdByUserId: input.createdByUserId,
    });
    if (items.length > 0) {
      await tx.insert(stockTransferItems).values(
        items.map((item) => ({
          id: ulid(),
          transferId,
          sourceLocationId: item.sourceLocationId,
          variantId: item.variantId,
          qty: item.qty,
        })),
      );
    }
    const row = await tx.query.stockTransfers.findFirst({
      where: eq(stockTransfers.id, transferId),
    });
    return row as Transfer;
  });
}

/** Move every line of a transfer through the ledger. */
async function moveLines(
  tx: Tx,
  transfer: Transfer,
  direction: "out" | "in",
  createdByUserId: string,
): Promise<void> {
  const items = await tx
    .select()
    .from(stockTransferItems)
    .where(eq(stockTransferItems.transferId, transfer.id));
  if (!items.length) throw new TransferError("EMPTY_TRANSFER");
  const type = direction === "out" ? "transfer_out" : "transfer_in";
  const sign = direction === "out" ? -1 : 1;
  for (const item of items) {
    const locationId = direction === "out" ? item.sourceLocationId : transfer.targetLocationId;
    await recordMovement(
      {
        variantId: item.variantId,
        locationId,
        type,
        qtyDelta: sign * item.qty,
        refType: "transfer",
        refId: transfer.id,
        createdByUserId,
      },
      tx,
    );
  }
}

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
      transfer,
      "out",
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
      transfer,
      "in",
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
      // `moveLines` with "in" will normally credit target location, 
      // but wait, for cancellation we need to credit the source location!
      // I should write a custom loop here.
      const items = await tx
        .select()
        .from(stockTransferItems)
        .where(eq(stockTransferItems.transferId, transfer.id));
      for (const item of items) {
        await recordMovement(
          {
            variantId: item.variantId,
            locationId: item.sourceLocationId,
            type: "transfer_in",
            qtyDelta: item.qty,
            refType: "transfer",
            refId: transfer.id,
            createdByUserId: cancelledByUserId,
          },
          tx,
        );
      }
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

/** Add lines to a draft transfer. Combines quantities if variant and source match. */
export async function addTransferItems(
  id: string,
  items: { variantId: string; qty: number; sourceLocationId: string }[],
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
      if (item.sourceLocationId === transfer.targetLocationId) {
        throw new TransferError("SAME_LOCATION", "source and target must differ");
      }
      if (!Number.isInteger(item.qty) || item.qty <= 0) {
        throw new TransferError("INVALID_INPUT", "item qty must be a positive integer");
      }
      const sloc = await tx.query.locations.findFirst({
        where: eq(locations.id, item.sourceLocationId),
      });
      if (!sloc) throw new TransferError("LOCATION_NOT_FOUND", item.sourceLocationId);
      const variant = await tx.query.productVariants.findFirst({
        where: eq(productVariants.id, item.variantId),
      });
      if (!variant) throw new TransferError("VARIANT_NOT_FOUND", item.variantId);
    }

    for (const item of items) {
      const existing = await tx.query.stockTransferItems.findFirst({
        where: and(
          eq(stockTransferItems.transferId, id),
          eq(stockTransferItems.variantId, item.variantId),
          eq(stockTransferItems.sourceLocationId, item.sourceLocationId)
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
          sourceLocationId: item.sourceLocationId,
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
