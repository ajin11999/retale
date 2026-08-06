ALTER TABLE `orders` ADD `idempotency_key` varchar(64);--> statement-breakpoint
CREATE INDEX `orders_idempotency_key_idx` ON `orders` (`idempotency_key`);