CREATE TABLE `interchange_groups` (
	`id` varchar(26) NOT NULL,
	`name` varchar(200) NOT NULL,
	`min_qty` int,
	`preferred_variant_id` varchar(26),
	`archived_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `interchange_groups_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `product_categories` DROP FOREIGN KEY `product_categories_preferred_variant_id_product_variants_id_fk`;
--> statement-breakpoint
ALTER TABLE `product_variants` ADD `interchange_group_id` varchar(26);--> statement-breakpoint
ALTER TABLE `interchange_groups` ADD CONSTRAINT `interchange_groups_preferred_variant_id_product_variants_id_fk` FOREIGN KEY (`preferred_variant_id`) REFERENCES `product_variants`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_variants` ADD CONSTRAINT `product_variants_interchange_group_id_interchange_groups_id_fk` FOREIGN KEY (`interchange_group_id`) REFERENCES `interchange_groups`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_categories` DROP COLUMN `preferred_variant_id`;--> statement-breakpoint
ALTER TABLE `product_categories` DROP COLUMN `min_qty`;