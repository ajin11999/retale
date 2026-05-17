CREATE TABLE `bundle_components` (
	`id` varchar(26) NOT NULL,
	`bundle_variant_id` varchar(26) NOT NULL,
	`component_variant_id` varchar(26) NOT NULL,
	`qty` bigint NOT NULL,
	CONSTRAINT `bundle_components_id` PRIMARY KEY(`id`),
	CONSTRAINT `bundle_components_bundle_component_unique` UNIQUE(`bundle_variant_id`,`component_variant_id`)
);
--> statement-breakpoint
ALTER TABLE `products` MODIFY COLUMN `kind` enum('physical','service','bundle') NOT NULL DEFAULT 'physical';--> statement-breakpoint
ALTER TABLE `order_items` ADD `snapshot_bundle_name` varchar(300);--> statement-breakpoint
ALTER TABLE `bundle_components` ADD CONSTRAINT `bundle_components_bundle_variant_id_product_variants_id_fk` FOREIGN KEY (`bundle_variant_id`) REFERENCES `product_variants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bundle_components` ADD CONSTRAINT `bundle_components_component_variant_id_product_variants_id_fk` FOREIGN KEY (`component_variant_id`) REFERENCES `product_variants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `bundle_components_bundle_variant_id_idx` ON `bundle_components` (`bundle_variant_id`);