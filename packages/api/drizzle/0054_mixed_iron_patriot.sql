ALTER TABLE `request_for_quotations` ADD CONSTRAINT `request_for_quotations_rfqNumber_unique` UNIQUE(`rfq_number`);
--> statement-breakpoint
CREATE TABLE `document_sequences` (
	`prefix` varchar(100) NOT NULL,
	`last_number` int NOT NULL DEFAULT 0,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `document_sequences_prefix` PRIMARY KEY(`prefix`)
);
--> statement-breakpoint
-- In RFQ-YYYYMM-NNNN the second hyphen is character 11.
INSERT INTO `document_sequences` (`prefix`, `last_number`)
SELECT SUBSTRING(`rfq_number`, 1, 11), MAX(CAST(SUBSTRING(`rfq_number`, 12) AS UNSIGNED))
FROM `request_for_quotations`
GROUP BY SUBSTRING(`rfq_number`, 1, 11);
