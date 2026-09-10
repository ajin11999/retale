ALTER TABLE `purchases` ADD `paid_at` timestamp;--> statement-breakpoint
ALTER TABLE `purchases` ADD `paid_amount_minor` decimal(19,2);--> statement-breakpoint
ALTER TABLE `purchases` ADD `paid_by_user_id` varchar(26);--> statement-breakpoint
ALTER TABLE `purchases` ADD CONSTRAINT `purchases_paid_by_user_id_users_id_fk` FOREIGN KEY (`paid_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;