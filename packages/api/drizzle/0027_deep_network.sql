CREATE TABLE `product_alerts` (
	`id` varchar(26) NOT NULL,
	`product_id` varchar(26) NOT NULL,
	`type` enum('low_margin','negative_margin','negative_price','data_anomaly') NOT NULL,
	`triggered_at` timestamp NOT NULL,
	`trigger_context` json,
	`acknowledged_at` timestamp,
	`acknowledged_by_user_id` varchar(26),
	`resolution_note` text,
	CONSTRAINT `product_alerts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `product_alerts` ADD CONSTRAINT `product_alerts_product_id_products_id_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_alerts` ADD CONSTRAINT `product_alerts_acknowledged_by_user_id_users_id_fk` FOREIGN KEY (`acknowledged_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `product_alerts_product_id_idx` ON `product_alerts` (`product_id`);--> statement-breakpoint
CREATE INDEX `product_alerts_type_idx` ON `product_alerts` (`type`);