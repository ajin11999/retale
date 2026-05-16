CREATE TABLE `locations` (
	`id` varchar(26) NOT NULL,
	`parent_id` varchar(26),
	`name` varchar(200) NOT NULL,
	`code` varchar(32),
	`notes` text,
	`archived_at` timestamp,
	`sort_order` int NOT NULL DEFAULT 0,
	`created_by_user_id` varchar(26),
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `locations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `stock_locations` (
	`id` varchar(26) NOT NULL,
	`variant_id` varchar(26) NOT NULL,
	`location_id` varchar(26),
	`qty` bigint NOT NULL DEFAULT 0,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `stock_locations_id` PRIMARY KEY(`id`),
	CONSTRAINT `stock_locations_variant_location_unique` UNIQUE(`variant_id`,`location_id`)
);
--> statement-breakpoint
CREATE TABLE `stock_movements` (
	`id` varchar(26) NOT NULL,
	`variant_id` varchar(26) NOT NULL,
	`location_id` varchar(26),
	`type` enum('purchase_receive','transfer_in','transfer_out','sale','sale_return','adjustment_in','adjustment_out','cost_override','initial_import') NOT NULL,
	`qty_delta` bigint NOT NULL,
	`unit_cost` bigint NOT NULL DEFAULT 0,
	`previous_cost` bigint,
	`ref_type` enum('purchase','order','transfer','adjustment','override','import') NOT NULL,
	`ref_id` varchar(26),
	`reason` varchar(500),
	`created_by_user_id` varchar(26),
	`created_at` timestamp NOT NULL,
	CONSTRAINT `stock_movements_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `locations` ADD CONSTRAINT `locations_parent_id_locations_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `locations`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `locations` ADD CONSTRAINT `locations_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_locations` ADD CONSTRAINT `stock_locations_variant_id_product_variants_id_fk` FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_locations` ADD CONSTRAINT `stock_locations_location_id_locations_id_fk` FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_movements` ADD CONSTRAINT `stock_movements_variant_id_product_variants_id_fk` FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_movements` ADD CONSTRAINT `stock_movements_location_id_locations_id_fk` FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_movements` ADD CONSTRAINT `stock_movements_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `locations_parent_id_idx` ON `locations` (`parent_id`);--> statement-breakpoint
CREATE INDEX `locations_archived_at_idx` ON `locations` (`archived_at`);--> statement-breakpoint
CREATE INDEX `stock_locations_location_id_idx` ON `stock_locations` (`location_id`);--> statement-breakpoint
CREATE INDEX `stock_movements_variant_id_idx` ON `stock_movements` (`variant_id`);--> statement-breakpoint
CREATE INDEX `stock_movements_location_id_idx` ON `stock_movements` (`location_id`);--> statement-breakpoint
CREATE INDEX `stock_movements_ref_idx` ON `stock_movements` (`ref_type`,`ref_id`);--> statement-breakpoint
CREATE INDEX `stock_movements_created_at_idx` ON `stock_movements` (`created_at`);