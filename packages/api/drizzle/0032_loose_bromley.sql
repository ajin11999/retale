ALTER TABLE `vendor_ledger` ADD `due_date` date;--> statement-breakpoint
ALTER TABLE `vendors` ADD `kind` enum('supplier','expedition') DEFAULT 'supplier' NOT NULL;--> statement-breakpoint
ALTER TABLE `vendors` ADD `payment_terms_days` int;--> statement-breakpoint
ALTER TABLE `purchase_delivery_items` ADD `vendor_id` varchar(26);--> statement-breakpoint
ALTER TABLE `purchase_delivery_items` ADD CONSTRAINT `purchase_delivery_items_vendor_id_vendors_id_fk` FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `vendors_kind_idx` ON `vendors` (`kind`);