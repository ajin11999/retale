CREATE TABLE `stock_transfer_items` (
	`id` varchar(26) NOT NULL,
	`transfer_id` varchar(26) NOT NULL,
	`variant_id` varchar(26) NOT NULL,
	`qty` bigint NOT NULL,
	CONSTRAINT `stock_transfer_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `stock_transfers` (
	`id` varchar(26) NOT NULL,
	`source_location_id` varchar(26) NOT NULL,
	`target_location_id` varchar(26) NOT NULL,
	`notes` varchar(500),
	`dispatched_at` timestamp,
	`received_at` timestamp,
	`cancelled_at` timestamp,
	`cancellation_reason` varchar(255),
	`created_by_user_id` varchar(26),
	`dispatched_by_user_id` varchar(26),
	`received_by_user_id` varchar(26),
	`cancelled_by_user_id` varchar(26),
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `stock_transfers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `stock_transfer_items` ADD CONSTRAINT `stock_transfer_items_transfer_id_stock_transfers_id_fk` FOREIGN KEY (`transfer_id`) REFERENCES `stock_transfers`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_transfer_items` ADD CONSTRAINT `stock_transfer_items_variant_id_product_variants_id_fk` FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_transfers` ADD CONSTRAINT `stock_transfers_source_location_id_locations_id_fk` FOREIGN KEY (`source_location_id`) REFERENCES `locations`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_transfers` ADD CONSTRAINT `stock_transfers_target_location_id_locations_id_fk` FOREIGN KEY (`target_location_id`) REFERENCES `locations`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_transfers` ADD CONSTRAINT `stock_transfers_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_transfers` ADD CONSTRAINT `stock_transfers_dispatched_by_user_id_users_id_fk` FOREIGN KEY (`dispatched_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_transfers` ADD CONSTRAINT `stock_transfers_received_by_user_id_users_id_fk` FOREIGN KEY (`received_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_transfers` ADD CONSTRAINT `stock_transfers_cancelled_by_user_id_users_id_fk` FOREIGN KEY (`cancelled_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `stock_transfer_items_transfer_id_idx` ON `stock_transfer_items` (`transfer_id`);--> statement-breakpoint
CREATE INDEX `stock_transfers_source_location_id_idx` ON `stock_transfers` (`source_location_id`);--> statement-breakpoint
CREATE INDEX `stock_transfers_target_location_id_idx` ON `stock_transfers` (`target_location_id`);