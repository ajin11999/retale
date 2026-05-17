CREATE TABLE `customer_ledger` (
	`id` varchar(26) NOT NULL,
	`customer_id` varchar(26) NOT NULL,
	`type` enum('sale_on_account','payment','refund_credit','adjustment','opening_balance') NOT NULL,
	`amount_minor` bigint NOT NULL,
	`ref_type` enum('order','order_item','payment','refund','adjustment','import'),
	`ref_id` varchar(26),
	`note` text,
	`pos_session_id` varchar(26),
	`created_by_user_id` varchar(26),
	`created_at` timestamp NOT NULL,
	CONSTRAINT `customer_ledger_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `customer_prices` (
	`id` varchar(26) NOT NULL,
	`customer_id` varchar(26) NOT NULL,
	`variant_id` varchar(26) NOT NULL,
	`price_minor` bigint NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `customer_prices_id` PRIMARY KEY(`id`),
	CONSTRAINT `customer_prices_customer_variant_unique` UNIQUE(`customer_id`,`variant_id`)
);
--> statement-breakpoint
CREATE TABLE `customers` (
	`id` varchar(26) NOT NULL,
	`name` varchar(300) NOT NULL,
	`phone` varchar(50),
	`email` varchar(200),
	`address` text,
	`notes` text,
	`balance_minor` bigint NOT NULL DEFAULT 0,
	`credit_limit_minor` bigint,
	`archived_at` timestamp,
	`created_by_user_id` varchar(26),
	`search_text` varchar(400) GENERATED ALWAYS AS (lower(concat(`name`, ' ', coalesce(`phone`, '')))) STORED,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `customers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `customer_ledger` ADD CONSTRAINT `customer_ledger_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `customer_ledger` ADD CONSTRAINT `customer_ledger_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `customer_prices` ADD CONSTRAINT `customer_prices_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `customer_prices` ADD CONSTRAINT `customer_prices_variant_id_product_variants_id_fk` FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `customers` ADD CONSTRAINT `customers_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `customer_ledger_customer_id_idx` ON `customer_ledger` (`customer_id`);--> statement-breakpoint
CREATE INDEX `customer_ledger_created_at_idx` ON `customer_ledger` (`created_at`);--> statement-breakpoint
CREATE INDEX `customer_prices_variant_id_idx` ON `customer_prices` (`variant_id`);--> statement-breakpoint
CREATE INDEX `customers_archived_at_idx` ON `customers` (`archived_at`);--> statement-breakpoint
CREATE INDEX `customers_phone_idx` ON `customers` (`phone`);--> statement-breakpoint
CREATE INDEX `customers_search_text_idx` ON `customers` (`search_text`);