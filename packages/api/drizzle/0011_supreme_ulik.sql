ALTER TABLE `products` ADD `primary_vendor_id` varchar(26);--> statement-breakpoint
ALTER TABLE `products` ADD `replenish_monitored` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `vendors` ADD `lead_time_days` int;--> statement-breakpoint
ALTER TABLE `products` ADD CONSTRAINT `products_primary_vendor_id_vendors_id_fk` FOREIGN KEY (`primary_vendor_id`) REFERENCES `vendors`(`id`) ON DELETE set null ON UPDATE no action;