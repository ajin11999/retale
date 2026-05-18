CREATE TABLE `workshop_settings` (
	`id` varchar(26) NOT NULL,
	`name` varchar(200) NOT NULL DEFAULT '',
	`phone` varchar(50),
	`email` varchar(200),
	`po_greeting` text,
	`po_footer` text,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `workshop_settings_id` PRIMARY KEY(`id`)
);
