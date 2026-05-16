CREATE TABLE `purchase_items` (
	`id` varchar(26) NOT NULL,
	`purchase_id` varchar(26) NOT NULL,
	`section_id` varchar(26),
	`variant_id` varchar(26),
	`description` varchar(300),
	`qty_ordered` bigint NOT NULL,
	`qty_delivered` bigint NOT NULL DEFAULT 0,
	`unit_cost_minor` bigint NOT NULL,
	`sort_order` int NOT NULL DEFAULT 0,
	CONSTRAINT `purchase_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `purchase_sections` (
	`id` varchar(26) NOT NULL,
	`purchase_id` varchar(26) NOT NULL,
	`name` varchar(200) NOT NULL,
	`sort_order` int NOT NULL DEFAULT 0,
	CONSTRAINT `purchase_sections_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `purchase_sends` (
	`id` varchar(26) NOT NULL,
	`purchase_id` varchar(26) NOT NULL,
	`channel` enum('whatsapp','email','manual') NOT NULL,
	`recipient` varchar(300) NOT NULL,
	`revision` int NOT NULL,
	`status` enum('prepared','sent') NOT NULL DEFAULT 'prepared',
	`sent_at` timestamp,
	`note` text,
	`created_by_user_id` varchar(26),
	`created_at` timestamp NOT NULL,
	CONSTRAINT `purchase_sends_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `purchases` (
	`id` varchar(26) NOT NULL,
	`vendor_id` varchar(26),
	`snapshot_vendor_name` varchar(300) NOT NULL,
	`date` date NOT NULL,
	`source_document` varchar(300),
	`memo` text,
	`status` enum('open','complete','cancelled') NOT NULL DEFAULT 'open',
	`revision` int NOT NULL DEFAULT 1,
	`last_sent_at` timestamp,
	`cancelled_at` timestamp,
	`cancelled_by_user_id` varchar(26),
	`created_by_user_id` varchar(26),
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `purchases_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `purchase_deliveries` (
	`id` varchar(26) NOT NULL,
	`date` date NOT NULL,
	`biller` varchar(200),
	`target_location_id` varchar(26) NOT NULL,
	`status` enum('draft','delivered','cancelled') NOT NULL DEFAULT 'draft',
	`delivered_at` timestamp,
	`delivered_by_user_id` varchar(26),
	`total_cost_minor` bigint NOT NULL DEFAULT 0,
	`created_by_user_id` varchar(26),
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `purchase_deliveries_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `purchase_delivery_items` (
	`id` varchar(26) NOT NULL,
	`delivery_id` varchar(26) NOT NULL,
	`parent_item_id` varchar(26),
	`purchase_item_id` varchar(26),
	`description` varchar(300) NOT NULL,
	`qty` bigint,
	`cost_minor` bigint NOT NULL,
	`sort_order` int NOT NULL DEFAULT 0,
	CONSTRAINT `purchase_delivery_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `purchase_items` ADD CONSTRAINT `purchase_items_purchase_id_purchases_id_fk` FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_items` ADD CONSTRAINT `purchase_items_section_id_purchase_sections_id_fk` FOREIGN KEY (`section_id`) REFERENCES `purchase_sections`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_items` ADD CONSTRAINT `purchase_items_variant_id_product_variants_id_fk` FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_sections` ADD CONSTRAINT `purchase_sections_purchase_id_purchases_id_fk` FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_sends` ADD CONSTRAINT `purchase_sends_purchase_id_purchases_id_fk` FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_sends` ADD CONSTRAINT `purchase_sends_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchases` ADD CONSTRAINT `purchases_vendor_id_vendors_id_fk` FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchases` ADD CONSTRAINT `purchases_cancelled_by_user_id_users_id_fk` FOREIGN KEY (`cancelled_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchases` ADD CONSTRAINT `purchases_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_deliveries` ADD CONSTRAINT `purchase_deliveries_target_location_id_locations_id_fk` FOREIGN KEY (`target_location_id`) REFERENCES `locations`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_deliveries` ADD CONSTRAINT `purchase_deliveries_delivered_by_user_id_users_id_fk` FOREIGN KEY (`delivered_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_deliveries` ADD CONSTRAINT `purchase_deliveries_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_delivery_items` ADD CONSTRAINT `purchase_delivery_items_delivery_id_purchase_deliveries_id_fk` FOREIGN KEY (`delivery_id`) REFERENCES `purchase_deliveries`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_delivery_items` ADD CONSTRAINT `purchase_delivery_items_purchase_item_id_purchase_items_id_fk` FOREIGN KEY (`purchase_item_id`) REFERENCES `purchase_items`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_delivery_items` ADD CONSTRAINT `pdi_parent_item_fk` FOREIGN KEY (`parent_item_id`) REFERENCES `purchase_delivery_items`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `purchase_items_purchase_id_idx` ON `purchase_items` (`purchase_id`);--> statement-breakpoint
CREATE INDEX `purchase_items_variant_id_idx` ON `purchase_items` (`variant_id`);--> statement-breakpoint
CREATE INDEX `purchase_sends_purchase_id_idx` ON `purchase_sends` (`purchase_id`);--> statement-breakpoint
CREATE INDEX `purchase_delivery_items_delivery_id_idx` ON `purchase_delivery_items` (`delivery_id`);--> statement-breakpoint
CREATE INDEX `purchase_delivery_items_purchase_item_id_idx` ON `purchase_delivery_items` (`purchase_item_id`);