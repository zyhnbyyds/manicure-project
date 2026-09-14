ALTER TABLE `biz_member_transaction` ADD `store_id` int unsigned;--> statement-breakpoint
CREATE INDEX `idx_txn_store` ON `biz_member_transaction` (`store_id`);--> statement-breakpoint
ALTER TABLE `biz_member_transaction` ADD CONSTRAINT `fk_txn_store` FOREIGN KEY (`store_id`) REFERENCES `sys_store`(`id`) ON DELETE SET NULL;