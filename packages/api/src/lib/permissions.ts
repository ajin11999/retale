// Permission catalog — the application contract. The DB stores role→key
// mappings; this file is the source of truth for which keys are valid.
// Unknown keys found in the DB are logged and ignored (forward-compat).
// See docs/design-decisions.md → "Permission catalog & templates".

/** Every permission key the application recognises, grouped by domain. */
export const PERMISSIONS = [
  // Orders
  "order.create_pos",
  "order.create_customer_sale",
  "order.edit_customer_sale",
  "order.close_customer_sale",
  "order.cancel_customer_sale",
  "order.void_item",
  "order.discount",
  "order.refund",
  "order.change_customer",
  "order.attribute",
  // POS sessions
  "session.open",
  "session.close_own",
  "session.close_others",
  "session.reopen",
  "session.force_close",
  // Products
  "product.create",
  "product.edit",
  "product.edit_cost",
  "product.edit_price",
  "product.edit_tax",
  "product.archive",
  "product.hard_delete",
  // Stock
  "stock.adjust",
  "stock.transfer.create",
  "stock.transfer.dispatch",
  "stock.transfer.receive",
  "stock.transfer.cancel",
  // Purchases
  "purchase.create",
  "purchase.edit",
  "purchase.cancel",
  "purchase.send",
  "delivery.draft",
  "delivery.commit",
  "delivery.cancel",
  // Customers
  "customer.create",
  "customer.edit",
  "customer.archive",
  "customer.set_credit_limit",
  "customer.adjustment",
  "customer.hard_delete",
  "debt.record_payment",
  // Vendors
  "vendor.create",
  "vendor.edit",
  "vendor.archive",
  "vendor.record_payment",
  "vendor.adjustment",
  "vendor.hard_delete",
  "vendor.variant_code.manage",
  // Locations
  "location.create",
  "location.edit",
  "location.archive",
  "location.hard_delete",
  // Points of sale
  "pos.create",
  "pos.edit",
  "pos.archive",
  "pos.hard_delete",
  // Tracking accounts
  "tracking_account.create",
  "tracking_account.edit",
  "tracking_account.archive",
  "tracking_account.payout",
  "tracking_account.deposit",
  "tracking_account.adjustment",
  "tracking_account.hard_delete",
  // Reports
  "report.sales.view",
  "report.cost.view",
  "report.margin.view",
  "report.ar_aging.view",
  "report.ap_aging.view",
  "report.session_variance.view",
  "report.journal_export",
  // Product alerts
  "alert.acknowledge",
  // Online catalog
  "catalog.manage",
  "catalog.publish",
  // Admin
  "admin.user.manage",
  "admin.role.manage",
  "admin.import.run",
  "admin.settings.manage",
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

/** True when `key` is a recognised permission in the current catalog. */
export function isKnownPermission(key: string): key is PermissionKey {
  return PERMISSION_SET.has(key);
}

// --- Seeded role templates (is_template = true, immutable via UI) ---

const CASHIER_LITE: PermissionKey[] = [
  "order.create_pos",
  "order.void_item",
  "session.open",
  "session.close_own",
  "debt.record_payment",
  "report.sales.view",
];

const CLERK: PermissionKey[] = [
  ...CASHIER_LITE,
  "order.discount",
  "order.refund",
  "order.attribute",
  "customer.create",
  "customer.edit",
  "customer.archive",
  "vendor.create",
  "vendor.edit",
  "vendor.archive",
  "vendor.record_payment",
  "vendor.variant_code.manage",
  "location.create",
  "location.edit",
  "location.archive",
  "purchase.create",
  "purchase.edit",
  "purchase.send",
  "delivery.draft",
  "product.create",
  "product.edit",
  "product.archive",
  "stock.transfer.create",
  "stock.transfer.dispatch",
  "stock.transfer.receive",
  "tracking_account.payout",
  "tracking_account.deposit",
  "alert.acknowledge",
];

const INVENTORY_MANAGER: PermissionKey[] = [
  ...CLERK,
  "product.edit_cost",
  "stock.adjust",
  "delivery.commit",
  "purchase.cancel",
  "stock.transfer.cancel",
  "tracking_account.create",
  "tracking_account.edit",
  "tracking_account.archive",
  "report.cost.view",
  "report.margin.view",
];

export interface RoleTemplate {
  name: string;
  description: string;
  permissionKeys: PermissionKey[];
}

/** The three templates shipped at install. Order: least → most privileged. */
export const ROLE_TEMPLATES: RoleTemplate[] = [
  {
    name: "cashier_lite",
    description: "New hire / restricted POS only.",
    permissionKeys: CASHIER_LITE,
  },
  {
    name: "clerk",
    description: "Daily POS plus light entity management.",
    permissionKeys: CLERK,
  },
  {
    name: "inventory_manager",
    description: "Everything a clerk does, plus stock and cost authority.",
    permissionKeys: INVENTORY_MANAGER,
  },
];
