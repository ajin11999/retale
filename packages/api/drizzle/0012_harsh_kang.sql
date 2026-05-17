ALTER TABLE `products` ADD `public_name` varchar(300);--> statement-breakpoint
ALTER TABLE `order_items` ADD `snapshot_public_name` varchar(300);