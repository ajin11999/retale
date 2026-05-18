CREATE TABLE `vendor_variant_codes` (
	`id` varchar(26) NOT NULL,
	`vendor_id` varchar(26) NOT NULL,
	`variant_id` varchar(26) NOT NULL,
	`code` varchar(100) NOT NULL,
	`is_preferred` boolean NOT NULL DEFAULT false,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `vendor_variant_codes_id` PRIMARY KEY(`id`),
	CONSTRAINT `vendor_variant_codes_vendor_variant_unique` UNIQUE(`vendor_id`,`variant_id`)
);
--> statement-breakpoint
ALTER TABLE `vendor_variant_codes` ADD CONSTRAINT `vendor_variant_codes_vendor_id_vendors_id_fk` FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `vendor_variant_codes` ADD CONSTRAINT `vendor_variant_codes_variant_id_product_variants_id_fk` FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `vendor_variant_codes_variant_id_idx` ON `vendor_variant_codes` (`variant_id`);--> statement-breakpoint
CREATE INDEX `vendor_variant_codes_code_idx` ON `vendor_variant_codes` (`code`);