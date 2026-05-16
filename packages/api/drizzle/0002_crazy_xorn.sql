CREATE TABLE `product_categories` (
	`id` varchar(26) NOT NULL,
	`name` varchar(200) NOT NULL,
	`parent_id` varchar(26),
	`min_qty` int,
	`min_margin_bps` int,
	`archived_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `product_categories_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `product_price_tiers` (
	`id` varchar(26) NOT NULL,
	`variant_id` varchar(26) NOT NULL,
	`min_qty` bigint NOT NULL,
	`price_minor` bigint NOT NULL,
	CONSTRAINT `product_price_tiers_id` PRIMARY KEY(`id`),
	CONSTRAINT `product_price_tiers_variant_min_qty_unique` UNIQUE(`variant_id`,`min_qty`)
);
--> statement-breakpoint
CREATE TABLE `product_variant_options` (
	`variant_id` varchar(26) NOT NULL,
	`option_name` varchar(100) NOT NULL,
	`option_value` varchar(200) NOT NULL,
	CONSTRAINT `product_variant_options_variant_id_option_name_pk` PRIMARY KEY(`variant_id`,`option_name`)
);
--> statement-breakpoint
CREATE TABLE `product_variants` (
	`id` varchar(26) NOT NULL,
	`product_id` varchar(26) NOT NULL,
	`sku` varchar(64) NOT NULL,
	`barcode` varchar(64),
	`label` varchar(200),
	`unit` enum('piece','g','ml','mm') NOT NULL DEFAULT 'piece',
	`qty_decimals` tinyint NOT NULL DEFAULT 0,
	`price_minor` bigint NOT NULL,
	`cost_minor` bigint NOT NULL DEFAULT 0,
	`total_qty` bigint NOT NULL DEFAULT 0,
	`sort_order` int NOT NULL DEFAULT 0,
	`tracking_account_id` varchar(26),
	`tracking_attribution_mode` enum('full','percent') NOT NULL DEFAULT 'full',
	`tracking_attribution_pct_bps` int,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `product_variants_id` PRIMARY KEY(`id`),
	CONSTRAINT `product_variants_sku_unique` UNIQUE(`sku`)
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` varchar(26) NOT NULL,
	`name` varchar(300) NOT NULL,
	`description` text,
	`kind` enum('physical','service') NOT NULL DEFAULT 'physical',
	`category_id` varchar(26),
	`tax_rate_bps` int NOT NULL DEFAULT 0,
	`price_mode` enum('tax_inclusive','tax_exclusive') NOT NULL,
	`min_qty` int,
	`min_margin_bps` int,
	`archived_at` timestamp,
	`created_by_user_id` varchar(26),
	`search_text` varchar(300) GENERATED ALWAYS AS (lower(`name`)) STORED,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `products_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `product_categories` ADD CONSTRAINT `product_categories_parent_id_product_categories_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `product_categories`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_price_tiers` ADD CONSTRAINT `product_price_tiers_variant_id_product_variants_id_fk` FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_variant_options` ADD CONSTRAINT `product_variant_options_variant_id_product_variants_id_fk` FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_variants` ADD CONSTRAINT `product_variants_product_id_products_id_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `products` ADD CONSTRAINT `products_category_id_product_categories_id_fk` FOREIGN KEY (`category_id`) REFERENCES `product_categories`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `products` ADD CONSTRAINT `products_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `product_categories_parent_id_idx` ON `product_categories` (`parent_id`);--> statement-breakpoint
CREATE INDEX `product_variants_product_id_idx` ON `product_variants` (`product_id`);--> statement-breakpoint
CREATE INDEX `product_variants_barcode_idx` ON `product_variants` (`barcode`);--> statement-breakpoint
CREATE INDEX `products_archived_at_idx` ON `products` (`archived_at`);--> statement-breakpoint
CREATE INDEX `products_category_id_idx` ON `products` (`category_id`);--> statement-breakpoint
CREATE INDEX `products_search_text_idx` ON `products` (`search_text`);