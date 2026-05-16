CREATE TABLE `vendor_ledger` (
	`id` varchar(26) NOT NULL,
	`vendor_id` varchar(26) NOT NULL,
	`type` enum('purchase_on_account','payment','refund_credit','adjustment','opening_balance') NOT NULL,
	`amount_minor` bigint NOT NULL,
	`ref_type` enum('purchase','purchase_delivery','payment','adjustment','import'),
	`ref_id` varchar(26),
	`note` text,
	`pos_session_id` varchar(26),
	`created_by_user_id` varchar(26),
	`created_at` timestamp NOT NULL,
	CONSTRAINT `vendor_ledger_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `vendors` (
	`id` varchar(26) NOT NULL,
	`name` varchar(300) NOT NULL,
	`phone` varchar(50),
	`email` varchar(200),
	`address` text,
	`tax_id` varchar(100),
	`notes` text,
	`balance_minor` bigint NOT NULL DEFAULT 0,
	`archived_at` timestamp,
	`created_by_user_id` varchar(26),
	`search_text` varchar(400) GENERATED ALWAYS AS (lower(concat(`name`, ' ', coalesce(`phone`, '')))) STORED,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `vendors_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `vendor_ledger` ADD CONSTRAINT `vendor_ledger_vendor_id_vendors_id_fk` FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `vendor_ledger` ADD CONSTRAINT `vendor_ledger_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `vendors` ADD CONSTRAINT `vendors_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `vendor_ledger_vendor_id_idx` ON `vendor_ledger` (`vendor_id`);--> statement-breakpoint
CREATE INDEX `vendor_ledger_created_at_idx` ON `vendor_ledger` (`created_at`);--> statement-breakpoint
CREATE INDEX `vendors_archived_at_idx` ON `vendors` (`archived_at`);--> statement-breakpoint
CREATE INDEX `vendors_phone_idx` ON `vendors` (`phone`);--> statement-breakpoint
CREATE INDEX `vendors_search_text_idx` ON `vendors` (`search_text`);