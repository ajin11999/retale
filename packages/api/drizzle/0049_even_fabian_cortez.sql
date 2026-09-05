CREATE TABLE `vendor_catalog_imports` (
	`id` varchar(26) NOT NULL,
	`vendor_id` varchar(26) NOT NULL,
	`file_name` varchar(300),
	`status` enum('pending','ready','confirmed','failed') NOT NULL DEFAULT 'pending',
	`row_count` int NOT NULL DEFAULT 0,
	`model_used` varchar(200),
	`token_usage_json` json,
	`error_code` varchar(100),
	`error_message` text,
 	`created_by_user_id` varchar(26),
 	`created_at` timestamp NOT NULL,
 	CONSTRAINT `vendor_catalog_imports_id` PRIMARY KEY(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
--> statement-breakpoint
CREATE TABLE `vendor_catalog_items` (
	`id` varchar(26) NOT NULL,
	`vendor_id` varchar(26) NOT NULL,
	`vendor_code` varchar(100) NOT NULL DEFAULT '',
	`name` varchar(300) NOT NULL,
	`unit_text` varchar(50),
	`price_minor` decimal(19,2) NOT NULL,
	`moq` int,
	`lead_time_days` int,
	`valid_from` date,
	`valid_to` date,
	`is_active` boolean NOT NULL DEFAULT true,
	`mapped_variant_id` varchar(26),
	`note` text,
	`source_import_id` varchar(26),
	`last_seen_at` timestamp,
	`archived_at` timestamp,
	`created_by_user_id` varchar(26),
	`search_text` varchar(400) GENERATED ALWAYS AS (lower(concat(`name`, ' ', coalesce(`vendor_code`, '')))) STORED,
 	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
 	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
 	CONSTRAINT `vendor_catalog_items_id` PRIMARY KEY(`id`),
 	CONSTRAINT `vendor_catalog_items_vendor_code_unique` UNIQUE(`vendor_id`,`vendor_code`,`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
--> statement-breakpoint
CREATE TABLE `vendor_catalog_prices` (
	`id` varchar(26) NOT NULL,
	`item_id` varchar(26) NOT NULL,
	`price_minor` decimal(19,2) NOT NULL,
	`valid_from` date,
	`source_import_id` varchar(26),
	`created_by_user_id` varchar(26),
 	`created_at` timestamp NOT NULL,
 	CONSTRAINT `vendor_catalog_prices_id` PRIMARY KEY(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
--> statement-breakpoint
ALTER TABLE `vendor_catalog_imports` ADD CONSTRAINT `vendor_catalog_imports_vendor_id_vendors_id_fk` FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `vendor_catalog_imports` ADD CONSTRAINT `vendor_catalog_imports_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `vendor_catalog_items` ADD CONSTRAINT `vendor_catalog_items_vendor_id_vendors_id_fk` FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `vendor_catalog_items` ADD CONSTRAINT `vendor_catalog_items_mapped_variant_id_product_variants_id_fk` FOREIGN KEY (`mapped_variant_id`) REFERENCES `product_variants`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `vendor_catalog_items` ADD CONSTRAINT `vendor_catalog_items_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `vendor_catalog_prices` ADD CONSTRAINT `vendor_catalog_prices_item_id_vendor_catalog_items_id_fk` FOREIGN KEY (`item_id`) REFERENCES `vendor_catalog_items`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `vendor_catalog_prices` ADD CONSTRAINT `vendor_catalog_prices_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `vendor_catalog_imports_vendor_id_idx` ON `vendor_catalog_imports` (`vendor_id`);--> statement-breakpoint
CREATE INDEX `vendor_catalog_items_vendor_id_idx` ON `vendor_catalog_items` (`vendor_id`);--> statement-breakpoint
CREATE INDEX `vendor_catalog_items_mapped_variant_idx` ON `vendor_catalog_items` (`mapped_variant_id`);--> statement-breakpoint
CREATE INDEX `vendor_catalog_items_search_text_idx` ON `vendor_catalog_items` (`search_text`);--> statement-breakpoint
CREATE INDEX `vendor_catalog_items_archived_at_idx` ON `vendor_catalog_items` (`archived_at`);--> statement-breakpoint
CREATE INDEX `vendor_catalog_prices_item_id_idx` ON `vendor_catalog_prices` (`item_id`);