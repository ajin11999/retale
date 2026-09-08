-- Backfill `total_cost_minor` as the charges total (cost nodes only, excluding
-- goods leaves). `syncTotal` in delivery-service.ts now computes this; existing
-- rows written under the old root-sum semantics are recomputed here.
UPDATE `purchase_deliveries` d SET `total_cost_minor` = (SELECT COALESCE(SUM(`cost_minor`), 0) FROM `purchase_delivery_items` WHERE `delivery_id` = d.`id` AND `purchase_item_id` IS NULL);
