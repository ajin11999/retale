ALTER TABLE `stock_transfer_items` DROP FOREIGN KEY `stock_transfer_items_variant_id_product_variants_id_fk`;
--> statement-breakpoint
ALTER TABLE `stock_transfer_items` MODIFY COLUMN `variant_id` varchar(26);--> statement-breakpoint
ALTER TABLE `stock_transfer_items` ADD `snapshot_sku` varchar(64);--> statement-breakpoint
ALTER TABLE `stock_transfer_items` ADD `snapshot_product_name` varchar(300);--> statement-breakpoint
ALTER TABLE `stock_transfer_items` ADD `snapshot_variant_label` varchar(200);--> statement-breakpoint
UPDATE `stock_transfer_items` `i` INNER JOIN `product_variants` `v` ON `v`.`id` = `i`.`variant_id` INNER JOIN `products` `p` ON `p`.`id` = `v`.`product_id` SET `i`.`snapshot_sku` = `v`.`sku`, `i`.`snapshot_product_name` = `p`.`name`, `i`.`snapshot_variant_label` = `v`.`label`;--> statement-breakpoint
ALTER TABLE `stock_transfer_items` MODIFY COLUMN `snapshot_sku` varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE `stock_transfer_items` MODIFY COLUMN `snapshot_product_name` varchar(300) NOT NULL;--> statement-breakpoint
ALTER TABLE `stock_transfer_items` ADD CONSTRAINT `stock_transfer_items_variant_id_product_variants_id_fk` FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON DELETE set null ON UPDATE no action;
