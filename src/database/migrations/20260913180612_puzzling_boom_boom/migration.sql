CREATE TABLE `sys_user_store` (
	`user_id` int unsigned NOT NULL,
	`store_id` int unsigned NOT NULL,
	CONSTRAINT `uq_user_store` UNIQUE INDEX(`user_id`,`store_id`),
	CONSTRAINT `fk_user_store_user` FOREIGN KEY (`user_id`) REFERENCES `sys_user`(`id`),
	CONSTRAINT `fk_user_store_store` FOREIGN KEY (`store_id`) REFERENCES `sys_store`(`id`)
);
--> statement-breakpoint
-- 数据回填（手工改写；drizzle 生成的是直接 `ADD store_id ... NOT NULL`）：
-- 非空表上直接加 NOT NULL 列，MySQL 会补隐式默认值 0 —— 那是个不存在的门店 id，
-- 后面加外键必然失败。所以改成**三步**：加可空列 → 回填 → 收紧为 NOT NULL。
-- 先兜一层默认门店（阶段 0 的迁移已保证存在，这里防有人手工删过）。
INSERT INTO `sys_store` (`code`, `name`, `sort`, `is_default`, `remark`)
SELECT 'MAIN', '美甲小铺', 0, true, '门店维度改造时自动补建'
FROM (SELECT 1) AS `seed`
WHERE NOT EXISTS (SELECT 1 FROM (SELECT `id` FROM `sys_store` LIMIT 1) AS `existing`);
--> statement-breakpoint
ALTER TABLE `biz_booking` ADD `store_id` int unsigned;
--> statement-breakpoint
ALTER TABLE `biz_payment` ADD `store_id` int unsigned;
--> statement-breakpoint
ALTER TABLE `biz_receivable` ADD `store_id` int unsigned;
--> statement-breakpoint
ALTER TABLE `biz_refund` ADD `store_id` int unsigned;
--> statement-breakpoint
-- 历史单据全部归到默认门店：改造前本来就是单店，这条回填在语义上是恒等的。
UPDATE `biz_booking`
   SET `store_id` = (SELECT `id` FROM (SELECT `id` FROM `sys_store` WHERE `is_default` = 1 ORDER BY `sort`, `id` LIMIT 1) AS `d`)
 WHERE `store_id` IS NULL;
--> statement-breakpoint
UPDATE `biz_payment`
   SET `store_id` = (SELECT `id` FROM (SELECT `id` FROM `sys_store` WHERE `is_default` = 1 ORDER BY `sort`, `id` LIMIT 1) AS `d`)
 WHERE `store_id` IS NULL;
--> statement-breakpoint
UPDATE `biz_receivable`
   SET `store_id` = (SELECT `id` FROM (SELECT `id` FROM `sys_store` WHERE `is_default` = 1 ORDER BY `sort`, `id` LIMIT 1) AS `d`)
 WHERE `store_id` IS NULL;
--> statement-breakpoint
UPDATE `biz_refund`
   SET `store_id` = (SELECT `id` FROM (SELECT `id` FROM `sys_store` WHERE `is_default` = 1 ORDER BY `sort`, `id` LIMIT 1) AS `d`)
 WHERE `store_id` IS NULL;
--> statement-breakpoint
-- 现存后台账号全部绑到默认门店：改造前所有人都在同一家店，这是**保持现有行为不变**的写法；
-- 不做的话，阶段 1 的门店范围规则会让所有老账号突然「看不到任何数据」。
INSERT INTO `sys_user_store` (`user_id`, `store_id`)
SELECT `u`.`id`, (SELECT `id` FROM (SELECT `id` FROM `sys_store` WHERE `is_default` = 1 ORDER BY `sort`, `id` LIMIT 1) AS `d`)
FROM `sys_user` AS `u`
WHERE `u`.`deleted_at` IS NULL;
--> statement-breakpoint
ALTER TABLE `biz_booking` MODIFY `store_id` int unsigned NOT NULL;
--> statement-breakpoint
ALTER TABLE `biz_payment` MODIFY `store_id` int unsigned NOT NULL;
--> statement-breakpoint
ALTER TABLE `biz_receivable` MODIFY `store_id` int unsigned NOT NULL;
--> statement-breakpoint
ALTER TABLE `biz_refund` MODIFY `store_id` int unsigned NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_booking_store_time` ON `biz_booking` (`store_id`,`start_at`);--> statement-breakpoint
CREATE INDEX `idx_payment_store_time` ON `biz_payment` (`store_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_receivable_store` ON `biz_receivable` (`store_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_refund_store_time` ON `biz_refund` (`store_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_user_store_store` ON `sys_user_store` (`store_id`);--> statement-breakpoint
ALTER TABLE `biz_booking` ADD CONSTRAINT `fk_booking_store` FOREIGN KEY (`store_id`) REFERENCES `sys_store`(`id`) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `biz_payment` ADD CONSTRAINT `fk_payment_store` FOREIGN KEY (`store_id`) REFERENCES `sys_store`(`id`) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `biz_receivable` ADD CONSTRAINT `fk_receivable_store` FOREIGN KEY (`store_id`) REFERENCES `sys_store`(`id`) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `biz_refund` ADD CONSTRAINT `fk_refund_store` FOREIGN KEY (`store_id`) REFERENCES `sys_store`(`id`) ON DELETE RESTRICT;
