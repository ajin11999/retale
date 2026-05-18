// Account-category catalog — the fixed chart of accounts the journal export
// classifies every event into. Defined in code (like the permission catalog);
// the accountant translates these ~30 keys to their GnuCash account tree once.
// See docs/design-decisions.md → "Accounting & exports" → "Account category
// catalog".

/** Every account category the journal export recognises, grouped by section. */
export const ACCOUNT_CATEGORIES = [
  // Assets
  "asset.cash", // cash in drawer (from pos_sessions / order_payments)
  "asset.bank.card", // card terminal settlements
  "asset.bank.transfer", // direct bank transfers in/out
  "asset.bank.qris", // QRIS settlements
  "asset.inventory", // stock value (from stock_movements)
  "asset.receivable", // AR (from customer_ledger)
  // Liabilities
  "liability.payable", // AP (from vendor_ledger)
  "liability.tax.output", // PPN collected on sales
  "liability.tax.input", // PPN paid on purchases
  // Revenue
  "revenue.sales", // product sales (from orders)
  "revenue.sales.discount", // contra-revenue from discounts
  "revenue.other", // misc income (rare)
  // COGS
  "cogs.product", // cost of goods sold (allocated WAC from stock_movements)
  "cogs.inventory_loss.damage", // stock write-off, damage
  "cogs.inventory_loss.theft", // stock write-off, theft
  "cogs.inventory_loss.variance", // recount variance
  // Expenses (mostly from non-stock purchase items)
  "expense.tools", // shop tools, equipment below the capitalize threshold
  "expense.consumables", // shop consumables (rags, cleaners, etc.)
  "expense.freight", // standalone freight bills not allocated to inventory
  "expense.office", // office supplies
  "expense.bad_debt", // customer adjustments (write-offs)
  "expense.other", // catchall
  // Adjustments
  "adjustment.vendor_credit", // vendor adjustments in our favor
  "adjustment.dispute", // vendor adjustments contested
  // Tracking accounts (mechanics, staff, partners, internal funds)
  "liability.tracking.staff", // owed to mechanics/staff
  "liability.tracking.partner", // owed to partners
  "liability.tracking.fund", // internal funds / reserves
  "liability.tracking.other", // catchall for tracking accounts
  "expense.commission", // staff commission expense
  "expense.partner_draw", // partner draw expense
  "expense.owner_draw", // owner draw expense
] as const;

export type AccountCategory = (typeof ACCOUNT_CATEGORIES)[number];

const CATEGORY_SET: ReadonlySet<string> = new Set(ACCOUNT_CATEGORIES);

/** True when `key` is a recognised account category in the current catalog. */
export function isKnownAccountCategory(key: string): key is AccountCategory {
  return CATEGORY_SET.has(key);
}
