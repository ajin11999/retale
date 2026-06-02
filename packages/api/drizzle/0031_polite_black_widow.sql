ALTER TABLE `products` MODIFY COLUMN `kind` enum('physical','service','bundle','open_price') NOT NULL DEFAULT 'physical';--> statement-breakpoint
ALTER TABLE `products` ADD `cost_ratio_bps` int;