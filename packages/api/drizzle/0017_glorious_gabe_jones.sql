CREATE TABLE `reorder_suggestions` (
	`id` varchar(26) NOT NULL,
	`variant_id` varchar(26) NOT NULL,
	`vendor_id` varchar(26),
	`current_stock` bigint NOT NULL,
	`reorder_point` bigint NOT NULL,
	`suggested_qty` bigint NOT NULL,
	`status` enum('open','converted','dismissed') NOT NULL DEFAULT 'open',
	`generated_at` timestamp NOT NULL,
	CONSTRAINT `reorder_suggestions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `product_variants` ADD `reorder_point` bigint;--> statement-breakpoint
ALTER TABLE `product_variants` ADD `reorder_qty` bigint;--> statement-breakpoint
ALTER TABLE `reorder_suggestions` ADD CONSTRAINT `reorder_suggestions_variant_id_product_variants_id_fk` FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reorder_suggestions` ADD CONSTRAINT `reorder_suggestions_vendor_id_vendors_id_fk` FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `reorder_suggestions_status_idx` ON `reorder_suggestions` (`status`);--> statement-breakpoint
CREATE INDEX `reorder_suggestions_vendor_id_idx` ON `reorder_suggestions` (`vendor_id`);