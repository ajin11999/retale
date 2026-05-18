ALTER TABLE `purchase_alerts` MODIFY COLUMN `type` enum('delivery_overdue','send_due') NOT NULL;--> statement-breakpoint
ALTER TABLE `purchases` ADD `send_due_date` date;