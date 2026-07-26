ALTER TABLE `purchase_items` ADD `base_cost_minor` decimal(19,2) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `purchase_items` ADD `discount` varchar(100);--> statement-breakpoint
ALTER TABLE `purchase_items` ADD `tax_pct` int;--> statement-breakpoint
UPDATE `purchase_items` SET `base_cost_minor` = `unit_cost_minor`;
