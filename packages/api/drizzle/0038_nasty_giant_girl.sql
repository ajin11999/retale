ALTER TABLE `product_price_tiers` MODIFY COLUMN `price_minor` decimal(19,2) NOT NULL;--> statement-breakpoint
ALTER TABLE `product_variants` MODIFY COLUMN `price_minor` decimal(19,2) NOT NULL;--> statement-breakpoint
ALTER TABLE `product_variants` MODIFY COLUMN `cost_minor` decimal(19,2) NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `stock_movements` MODIFY COLUMN `unit_cost` decimal(19,2) NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `stock_movements` MODIFY COLUMN `previous_cost` decimal(19,2);--> statement-breakpoint
ALTER TABLE `vendor_ledger` MODIFY COLUMN `amount_minor` decimal(19,2) NOT NULL;--> statement-breakpoint
ALTER TABLE `vendors` MODIFY COLUMN `balance_minor` decimal(19,2) NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `purchase_items` MODIFY COLUMN `unit_cost_minor` decimal(19,2) NOT NULL;--> statement-breakpoint
ALTER TABLE `purchase_deliveries` MODIFY COLUMN `total_cost_minor` decimal(19,2) NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `purchase_delivery_items` MODIFY COLUMN `cost_minor` decimal(19,2) NOT NULL;--> statement-breakpoint
ALTER TABLE `purchase_delivery_items` MODIFY COLUMN `allocated_freight_minor` decimal(19,2);--> statement-breakpoint
ALTER TABLE `customer_ledger` MODIFY COLUMN `amount_minor` decimal(19,2) NOT NULL;--> statement-breakpoint
ALTER TABLE `customer_prices` MODIFY COLUMN `price_minor` decimal(19,2) NOT NULL;--> statement-breakpoint
ALTER TABLE `customers` MODIFY COLUMN `balance_minor` decimal(19,2) NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `customers` MODIFY COLUMN `credit_limit_minor` decimal(19,2);--> statement-breakpoint
ALTER TABLE `pos_sessions` MODIFY COLUMN `opening_cash_minor` decimal(19,2) NOT NULL;--> statement-breakpoint
ALTER TABLE `pos_sessions` MODIFY COLUMN `closing_cash_minor` decimal(19,2);--> statement-breakpoint
ALTER TABLE `pos_sessions` MODIFY COLUMN `variance_minor` decimal(19,2);--> statement-breakpoint
ALTER TABLE `order_items` MODIFY COLUMN `discount_minor` decimal(19,2) NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `order_items` MODIFY COLUMN `snapshot_price_minor` decimal(19,2) NOT NULL;--> statement-breakpoint
ALTER TABLE `order_items` MODIFY COLUMN `snapshot_cost_minor` decimal(19,2) NOT NULL;--> statement-breakpoint
ALTER TABLE `order_items` MODIFY COLUMN `attribution_amount_minor` decimal(19,2) NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `order_payments` MODIFY COLUMN `amount_minor` decimal(19,2) NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` MODIFY COLUMN `total_minor` decimal(19,2) NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `tracking_account_ledger` MODIFY COLUMN `amount_minor` decimal(19,2) NOT NULL;--> statement-breakpoint
ALTER TABLE `tracking_accounts` MODIFY COLUMN `balance_minor` decimal(19,2) NOT NULL DEFAULT 0;