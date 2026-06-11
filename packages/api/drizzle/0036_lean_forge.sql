ALTER TABLE `purchase_delivery_items` DROP FOREIGN KEY `pdi_applies_purchase_fk`;
--> statement-breakpoint
ALTER TABLE `purchase_deliveries` MODIFY COLUMN `target_location_id` varchar(26);--> statement-breakpoint
ALTER TABLE `purchase_deliveries` ADD `kind` enum('transit','arrival') DEFAULT 'arrival' NOT NULL;--> statement-breakpoint
ALTER TABLE `purchase_delivery_items` ADD `allocated_freight_minor` bigint;