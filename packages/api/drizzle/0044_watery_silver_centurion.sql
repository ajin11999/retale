ALTER TABLE `stock_transfers` DROP FOREIGN KEY IF EXISTS `stock_transfers_source_location_id_locations_id_fk`;
--> statement-breakpoint
DROP INDEX IF EXISTS `stock_transfers_source_location_id_idx` ON `stock_transfers`;--> statement-breakpoint
ALTER TABLE `stock_transfer_items` ADD COLUMN IF NOT EXISTS `source_location_id` varchar(26) NOT NULL;--> statement-breakpoint
UPDATE `stock_transfer_items` sti JOIN `stock_transfers` st ON sti.transfer_id = st.id SET sti.source_location_id = st.source_location_id WHERE sti.source_location_id = '';--> statement-breakpoint
ALTER TABLE `stock_transfer_items` ADD CONSTRAINT `stock_transfer_items_source_location_id_locations_id_fk` FOREIGN KEY IF NOT EXISTS (`source_location_id`) REFERENCES `locations`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `stock_transfer_items_source_location_id_idx` ON `stock_transfer_items` (`source_location_id`);--> statement-breakpoint
ALTER TABLE `stock_transfers` DROP COLUMN IF EXISTS `source_location_id`;