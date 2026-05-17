CREATE TABLE `two_factor_challenges` (
	`id` varchar(26) NOT NULL,
	`user_id` varchar(26) NOT NULL,
	`failed_attempts` int NOT NULL DEFAULT 0,
	`consumed_at` timestamp,
	`expires_at` timestamp NOT NULL,
	`created_at` timestamp NOT NULL,
	CONSTRAINT `two_factor_challenges_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user_recovery_codes` (
	`id` varchar(26) NOT NULL,
	`user_id` varchar(26) NOT NULL,
	`code_hash` varchar(255) NOT NULL,
	`used_at` timestamp,
	CONSTRAINT `user_recovery_codes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user_two_factor` (
	`user_id` varchar(26) NOT NULL,
	`secret_encrypted` varchar(512) NOT NULL,
	`confirmed_at` timestamp,
	`last_used_step` bigint,
	`created_at` timestamp NOT NULL,
	CONSTRAINT `user_two_factor_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
ALTER TABLE `two_factor_challenges` ADD CONSTRAINT `two_factor_challenges_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_recovery_codes` ADD CONSTRAINT `user_recovery_codes_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_two_factor` ADD CONSTRAINT `user_two_factor_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `two_factor_challenges_user_id_idx` ON `two_factor_challenges` (`user_id`);--> statement-breakpoint
CREATE INDEX `user_recovery_codes_user_id_idx` ON `user_recovery_codes` (`user_id`);