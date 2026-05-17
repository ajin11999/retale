CREATE TABLE `login_attempts` (
	`id` varchar(26) NOT NULL,
	`username` varchar(100) NOT NULL,
	`ip` varchar(45),
	`succeeded` boolean NOT NULL,
	`attempted_at` timestamp NOT NULL,
	CONSTRAINT `login_attempts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `login_attempts_username_idx` ON `login_attempts` (`username`,`attempted_at`);