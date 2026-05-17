CREATE TABLE `tracking_account_ledger` (
	`id` varchar(26) NOT NULL,
	`tracking_account_id` varchar(26) NOT NULL,
	`type` enum('attribution','payout','deposit','adjustment','opening_balance') NOT NULL,
	`amount_minor` bigint NOT NULL,
	`ref_type` enum('order_item','order','manual','import','adjustment'),
	`ref_id` varchar(26),
	`counter_category_override` varchar(100),
	`note` text,
	`pos_session_id` varchar(26),
	`created_by_user_id` varchar(26),
	`created_at` timestamp NOT NULL,
	CONSTRAINT `tracking_account_ledger_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tracking_accounts` (
	`id` varchar(26) NOT NULL,
	`parent_id` varchar(26),
	`name` varchar(300) NOT NULL,
	`code` varchar(64),
	`account_category` varchar(100) NOT NULL,
	`counter_category` varchar(100) NOT NULL,
	`notes` text,
	`balance_minor` bigint NOT NULL DEFAULT 0,
	`archived_at` timestamp,
	`created_by_user_id` varchar(26),
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `tracking_accounts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `tracking_account_ledger` ADD CONSTRAINT `tracking_account_ledger_account_id_fk` FOREIGN KEY (`tracking_account_id`) REFERENCES `tracking_accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tracking_account_ledger` ADD CONSTRAINT `tracking_account_ledger_pos_session_id_pos_sessions_id_fk` FOREIGN KEY (`pos_session_id`) REFERENCES `pos_sessions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tracking_account_ledger` ADD CONSTRAINT `tracking_account_ledger_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tracking_accounts` ADD CONSTRAINT `tracking_accounts_parent_id_tracking_accounts_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `tracking_accounts`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tracking_accounts` ADD CONSTRAINT `tracking_accounts_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `tracking_account_ledger_account_id_idx` ON `tracking_account_ledger` (`tracking_account_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `tracking_account_ledger_ref_idx` ON `tracking_account_ledger` (`ref_type`,`ref_id`);--> statement-breakpoint
CREATE INDEX `tracking_accounts_parent_id_idx` ON `tracking_accounts` (`parent_id`);--> statement-breakpoint
CREATE INDEX `tracking_accounts_archived_at_idx` ON `tracking_accounts` (`archived_at`);--> statement-breakpoint
ALTER TABLE `product_variants` ADD CONSTRAINT `product_variants_tracking_account_id_tracking_accounts_id_fk` FOREIGN KEY (`tracking_account_id`) REFERENCES `tracking_accounts`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_items` ADD CONSTRAINT `order_items_attribution_account_id_tracking_accounts_id_fk` FOREIGN KEY (`attribution_account_id`) REFERENCES `tracking_accounts`(`id`) ON DELETE set null ON UPDATE no action;