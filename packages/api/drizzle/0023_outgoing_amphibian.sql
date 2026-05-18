CREATE TABLE `purchase_alerts` (
	`id` varchar(26) NOT NULL,
	`purchase_id` varchar(26) NOT NULL,
	`type` enum('delivery_overdue') NOT NULL,
	`triggered_at` timestamp NOT NULL,
	`trigger_context` json,
	`acknowledged_at` timestamp,
	`acknowledged_by_user_id` varchar(26),
	`resolution_note` text,
	CONSTRAINT `purchase_alerts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `purchase_alerts` ADD CONSTRAINT `purchase_alerts_purchase_id_purchases_id_fk` FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_alerts` ADD CONSTRAINT `purchase_alerts_acknowledged_by_user_id_users_id_fk` FOREIGN KEY (`acknowledged_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `purchase_alerts_purchase_id_idx` ON `purchase_alerts` (`purchase_id`);--> statement-breakpoint
CREATE INDEX `purchase_alerts_type_idx` ON `purchase_alerts` (`type`);