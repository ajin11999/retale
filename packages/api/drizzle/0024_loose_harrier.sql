CREATE TABLE `product_images` (
	`id` varchar(26) NOT NULL,
	`product_id` varchar(26) NOT NULL,
	`detail_url` varchar(500) NOT NULL,
	`thumbnail_url` varchar(500) NOT NULL,
	`width` int NOT NULL,
	`height` int NOT NULL,
	`sort_order` int NOT NULL DEFAULT 0,
	`created_at` timestamp NOT NULL,
	CONSTRAINT `product_images_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `product_images` ADD CONSTRAINT `product_images_product_id_products_id_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `product_images_product_id_idx` ON `product_images` (`product_id`);