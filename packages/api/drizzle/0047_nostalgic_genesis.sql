CREATE TABLE `request_for_quotations` (
	`id` varchar(26) NOT NULL,
	`rfq_number` varchar(100) NOT NULL,
	`vendor_id` varchar(26),
	`snapshot_vendor_name` varchar(300),
	`date` date NOT NULL,
	`due_date` date,
	`status` enum('draft','sent','received','awarded','cancelled') NOT NULL DEFAULT 'draft',
	`memo` text,
	`terms_and_conditions` text,
	`created_by_user_id` varchar(26),
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `request_for_quotations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `rfq_items` (
	`id` varchar(26) NOT NULL,
	`rfq_id` varchar(26) NOT NULL,
	`section_id` varchar(26),
	`requisition_item_id` varchar(26),
	`variant_id` varchar(26),
	`description` varchar(300),
	`qty_requested` bigint NOT NULL,
	`target_unit_cost_minor` decimal(19,2) NOT NULL DEFAULT 0,
	`quoted_unit_cost_minor` decimal(19,2) NOT NULL DEFAULT 0,
	`sort_order` int NOT NULL DEFAULT 0,
	CONSTRAINT `rfq_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `rfq_sections` (
	`id` varchar(26) NOT NULL,
	`rfq_id` varchar(26) NOT NULL,
	`name` varchar(200) NOT NULL,
	`sort_order` int NOT NULL DEFAULT 0,
	CONSTRAINT `rfq_sections_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `purchase_requisition_items` ADD `estimated_unit_cost_minor` decimal(19,2) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `request_for_quotations` ADD CONSTRAINT `request_for_quotations_vendor_id_vendors_id_fk` FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `request_for_quotations` ADD CONSTRAINT `request_for_quotations_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rfq_items` ADD CONSTRAINT `rfq_items_requisition_item_id_purchase_requisition_items_id_fk` FOREIGN KEY (`requisition_item_id`) REFERENCES `purchase_requisition_items`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rfq_items` ADD CONSTRAINT `rfq_items_variant_id_product_variants_id_fk` FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rfq_items` ADD CONSTRAINT `rfq_item_rfq_id_fk` FOREIGN KEY (`rfq_id`) REFERENCES `request_for_quotations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rfq_items` ADD CONSTRAINT `rfq_item_sec_id_fk` FOREIGN KEY (`section_id`) REFERENCES `rfq_sections`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rfq_sections` ADD CONSTRAINT `rfq_sec_rfq_id_fk` FOREIGN KEY (`rfq_id`) REFERENCES `request_for_quotations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `rfq_items_rfq_id_idx` ON `rfq_items` (`rfq_id`);--> statement-breakpoint
CREATE INDEX `rfq_items_variant_id_idx` ON `rfq_items` (`variant_id`);--> statement-breakpoint
CREATE INDEX `rfq_items_req_item_id_idx` ON `rfq_items` (`requisition_item_id`);