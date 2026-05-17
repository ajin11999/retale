CREATE TABLE `points_of_sale` (
	`id` varchar(26) NOT NULL,
	`location_id` varchar(26) NOT NULL,
	`code` varchar(16) NOT NULL,
	`name` varchar(200) NOT NULL,
	`notes` text,
	`archived_at` timestamp,
	`created_by_user_id` varchar(26),
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `points_of_sale_id` PRIMARY KEY(`id`),
	CONSTRAINT `points_of_sale_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `pos_sessions` (
	`id` varchar(26) NOT NULL,
	`pos_id` varchar(26) NOT NULL,
	`opened_by_user_id` varchar(26) NOT NULL,
	`opened_at` timestamp NOT NULL,
	`opening_cash_minor` bigint NOT NULL,
	`closed_by_user_id` varchar(26),
	`closed_at` timestamp,
	`closing_cash_minor` bigint,
	`variance_minor` bigint,
	`force_closed` boolean NOT NULL DEFAULT false,
	`z_report_json` json,
	`notes` text,
	`open_pos_id` varchar(26) GENERATED ALWAYS AS (if(`closed_at` is null, `pos_id`, null)) STORED,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `pos_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `pos_sessions_one_open_per_pos_unique` UNIQUE(`open_pos_id`)
);
--> statement-breakpoint
ALTER TABLE `points_of_sale` ADD CONSTRAINT `points_of_sale_location_id_locations_id_fk` FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `points_of_sale` ADD CONSTRAINT `points_of_sale_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `pos_sessions` ADD CONSTRAINT `pos_sessions_pos_id_points_of_sale_id_fk` FOREIGN KEY (`pos_id`) REFERENCES `points_of_sale`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `pos_sessions` ADD CONSTRAINT `pos_sessions_opened_by_user_id_users_id_fk` FOREIGN KEY (`opened_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `pos_sessions` ADD CONSTRAINT `pos_sessions_closed_by_user_id_users_id_fk` FOREIGN KEY (`closed_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `points_of_sale_location_id_idx` ON `points_of_sale` (`location_id`);--> statement-breakpoint
CREATE INDEX `points_of_sale_archived_at_idx` ON `points_of_sale` (`archived_at`);--> statement-breakpoint
CREATE INDEX `pos_sessions_pos_id_idx` ON `pos_sessions` (`pos_id`);--> statement-breakpoint
CREATE INDEX `pos_sessions_opened_by_user_id_idx` ON `pos_sessions` (`opened_by_user_id`);--> statement-breakpoint
ALTER TABLE `vendor_ledger` ADD CONSTRAINT `vendor_ledger_pos_session_id_pos_sessions_id_fk` FOREIGN KEY (`pos_session_id`) REFERENCES `pos_sessions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `customer_ledger` ADD CONSTRAINT `customer_ledger_pos_session_id_pos_sessions_id_fk` FOREIGN KEY (`pos_session_id`) REFERENCES `pos_sessions`(`id`) ON DELETE no action ON UPDATE no action;