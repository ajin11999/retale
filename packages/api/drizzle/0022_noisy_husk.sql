CREATE TABLE `catalog_publishes` (
	`id` varchar(26) NOT NULL,
	`trigger` enum('manual','scheduled') NOT NULL,
	`status` enum('success','error') NOT NULL,
	`product_count` int NOT NULL DEFAULT 0,
	`snapshot_version` varchar(26),
	`error_message` text,
	`published_by_user_id` varchar(26),
	`created_at` timestamp NOT NULL,
	CONSTRAINT `catalog_publishes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `products` ADD `online_visible` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `online_price_mode` enum('exclude','peek','show') DEFAULT 'exclude' NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `online_stock_mode` enum('show_real','peek','hide') DEFAULT 'hide' NOT NULL;--> statement-breakpoint
ALTER TABLE `catalog_publishes` ADD CONSTRAINT `catalog_publishes_published_by_user_id_users_id_fk` FOREIGN KEY (`published_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;