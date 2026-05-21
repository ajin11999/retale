CREATE TABLE `addresses` (
	`id` varchar(26) NOT NULL,
	`label` varchar(200) NOT NULL,
	`recipient_name` varchar(300),
	`phone` varchar(50),
	`line` text NOT NULL,
	`notes` text,
	`is_default` boolean NOT NULL DEFAULT false,
	`archived_at` timestamp,
	`created_by_user_id` varchar(26),
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `addresses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `vendors` ADD `default_ship_to_address_id` varchar(26);--> statement-breakpoint
ALTER TABLE `addresses` ADD CONSTRAINT `addresses_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `addresses_archived_at_idx` ON `addresses` (`archived_at`);--> statement-breakpoint
ALTER TABLE `vendors` ADD CONSTRAINT `vendors_default_ship_to_address_id_addresses_id_fk` FOREIGN KEY (`default_ship_to_address_id`) REFERENCES `addresses`(`id`) ON DELETE set null ON UPDATE no action;