CREATE TABLE `order_items` (
	`id` varchar(26) NOT NULL,
	`order_id` varchar(26) NOT NULL,
	`variant_id` varchar(26),
	`product_id` varchar(26),
	`qty` bigint NOT NULL,
	`discount_minor` bigint NOT NULL DEFAULT 0,
	`snapshot_product_name` varchar(300) NOT NULL,
	`snapshot_product_sku` varchar(64) NOT NULL,
	`snapshot_product_barcode` varchar(64),
	`snapshot_variant_label` varchar(200),
	`snapshot_unit` enum('piece','g','ml','mm') NOT NULL,
	`snapshot_category_name` varchar(200),
	`snapshot_price_minor` bigint NOT NULL,
	`snapshot_cost_minor` bigint NOT NULL,
	`snapshot_tax_rate_bps` int NOT NULL,
	`snapshot_price_mode` enum('tax_inclusive','tax_exclusive') NOT NULL,
	`snapshot_tracking_account_name` varchar(200),
	`attribution_account_id` varchar(26),
	`attribution_amount_minor` bigint NOT NULL DEFAULT 0,
	`voided_at` timestamp,
	`voided_by_user_id` varchar(26),
	`void_reason` varchar(255),
	`created_at` timestamp NOT NULL,
	CONSTRAINT `order_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `order_payments` (
	`id` varchar(26) NOT NULL,
	`order_id` varchar(26) NOT NULL,
	`method` enum('cash') NOT NULL,
	`amount_minor` bigint NOT NULL,
	`pos_session_id` varchar(26),
	`created_by_user_id` varchar(26),
	`created_at` timestamp NOT NULL,
	CONSTRAINT `order_payments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` varchar(26) NOT NULL,
	`display_number` varchar(64),
	`customer_id` varchar(26),
	`snapshot_customer_name` varchar(300),
	`pos_session_id` varchar(26),
	`total_minor` bigint NOT NULL DEFAULT 0,
	`closed_at` timestamp,
	`closed_by_user_id` varchar(26),
	`cancelled_at` timestamp,
	`cancelled_by_user_id` varchar(26),
	`cancellation_reason` varchar(255),
	`return_of_order_id` varchar(26),
	`created_by_user_id` varchar(26),
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `orders_id` PRIMARY KEY(`id`),
	CONSTRAINT `orders_displayNumber_unique` UNIQUE(`display_number`)
);
--> statement-breakpoint
ALTER TABLE `order_items` ADD CONSTRAINT `order_items_order_id_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_items` ADD CONSTRAINT `order_items_variant_id_product_variants_id_fk` FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_items` ADD CONSTRAINT `order_items_product_id_products_id_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_items` ADD CONSTRAINT `order_items_voided_by_user_id_users_id_fk` FOREIGN KEY (`voided_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_payments` ADD CONSTRAINT `order_payments_order_id_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_payments` ADD CONSTRAINT `order_payments_pos_session_id_pos_sessions_id_fk` FOREIGN KEY (`pos_session_id`) REFERENCES `pos_sessions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_payments` ADD CONSTRAINT `order_payments_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `orders` ADD CONSTRAINT `orders_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `orders` ADD CONSTRAINT `orders_pos_session_id_pos_sessions_id_fk` FOREIGN KEY (`pos_session_id`) REFERENCES `pos_sessions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `orders` ADD CONSTRAINT `orders_closed_by_user_id_users_id_fk` FOREIGN KEY (`closed_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `orders` ADD CONSTRAINT `orders_cancelled_by_user_id_users_id_fk` FOREIGN KEY (`cancelled_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `orders` ADD CONSTRAINT `orders_return_of_order_id_orders_id_fk` FOREIGN KEY (`return_of_order_id`) REFERENCES `orders`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `orders` ADD CONSTRAINT `orders_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `order_items_order_id_idx` ON `order_items` (`order_id`);--> statement-breakpoint
CREATE INDEX `order_items_variant_id_idx` ON `order_items` (`variant_id`);--> statement-breakpoint
CREATE INDEX `order_payments_order_id_idx` ON `order_payments` (`order_id`);--> statement-breakpoint
CREATE INDEX `order_payments_pos_session_id_idx` ON `order_payments` (`pos_session_id`);--> statement-breakpoint
CREATE INDEX `orders_customer_id_idx` ON `orders` (`customer_id`);--> statement-breakpoint
CREATE INDEX `orders_pos_session_id_idx` ON `orders` (`pos_session_id`);--> statement-breakpoint
CREATE INDEX `orders_closed_at_idx` ON `orders` (`closed_at`);--> statement-breakpoint
CREATE INDEX `orders_return_of_order_id_idx` ON `orders` (`return_of_order_id`);