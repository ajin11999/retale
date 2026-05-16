CREATE TABLE `sessions` (
	`id` varchar(26) NOT NULL,
	`user_id` varchar(26) NOT NULL,
	`refresh_token_hash` varchar(255) NOT NULL,
	`user_agent` varchar(255),
	`ip` varchar(45),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`last_used_at` timestamp NOT NULL DEFAULT (now()),
	`expires_at` timestamp NOT NULL,
	`revoked_at` timestamp,
	CONSTRAINT `sessions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `sessions_user_id_idx` ON `sessions` (`user_id`);