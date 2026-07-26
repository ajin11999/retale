CREATE TABLE `purchase_requisition_items` (
	`id` varchar(26) NOT NULL,
	`requisition_id` varchar(26) NOT NULL,
	`section_id` varchar(26),
	`variant_id` varchar(26),
	`description` varchar(300),
	`qty_requested` bigint NOT NULL,
	`qty_ordered` bigint NOT NULL DEFAULT 0,
	`sort_order` int NOT NULL DEFAULT 0,
	CONSTRAINT `purchase_requisition_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `purchase_requisition_sections` (
	`id` varchar(26) NOT NULL,
	`requisition_id` varchar(26) NOT NULL,
	`name` varchar(200) NOT NULL,
	`sort_order` int NOT NULL DEFAULT 0,
	CONSTRAINT `purchase_requisition_sections_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `purchase_requisitions` (
	`id` varchar(26) NOT NULL,
	`name` varchar(200) NOT NULL,
	`status` enum('draft','open','partially_ordered','fully_ordered','cancelled') NOT NULL DEFAULT 'draft',
	`created_by_user_id` varchar(26),
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `purchase_requisitions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `purchase_items` ADD `requisition_item_id` varchar(26);--> statement-breakpoint
ALTER TABLE `purchase_requisition_items` ADD CONSTRAINT `purchase_requisition_items_variant_id_product_variants_id_fk` FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_requisition_items` ADD CONSTRAINT `pri_req_id_fk` FOREIGN KEY (`requisition_id`) REFERENCES `purchase_requisitions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_requisition_items` ADD CONSTRAINT `pri_sec_id_fk` FOREIGN KEY (`section_id`) REFERENCES `purchase_requisition_sections`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_requisition_sections` ADD CONSTRAINT `prs_req_id_fk` FOREIGN KEY (`requisition_id`) REFERENCES `purchase_requisitions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_requisitions` ADD CONSTRAINT `purchase_requisitions_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `pr_items_requisition_id_idx` ON `purchase_requisition_items` (`requisition_id`);--> statement-breakpoint
CREATE INDEX `pr_items_variant_id_idx` ON `purchase_requisition_items` (`variant_id`);--> statement-breakpoint
ALTER TABLE `purchase_items` ADD CONSTRAINT `pi_req_item_id_fk` FOREIGN KEY (`requisition_item_id`) REFERENCES `purchase_requisition_items`(`id`) ON DELETE set null ON UPDATE no action;