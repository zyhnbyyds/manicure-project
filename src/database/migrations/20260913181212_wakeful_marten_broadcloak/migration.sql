-- 周期预约规则带上门店（生成出来的预约继承它）。
--
-- 与阶段 1 前一张迁移同样的三步走：**先加可空列 → 回填 → 再收紧 NOT NULL** ——
-- 非空表上直接 `ADD ... NOT NULL` 会让 MySQL 补隐式默认值 0，
-- 那是个不存在的门店 id，后面加外键必然失败。
ALTER TABLE `biz_booking_recurrence` ADD `store_id` int unsigned;
--> statement-breakpoint
-- 历史规则归默认门店（改造前本来就是单店，语义恒等）
UPDATE `biz_booking_recurrence`
   SET `store_id` = (SELECT `id` FROM (SELECT `id` FROM `sys_store` WHERE `is_default` = 1 ORDER BY `sort`, `id` LIMIT 1) AS `d`)
 WHERE `store_id` IS NULL;
--> statement-breakpoint
ALTER TABLE `biz_booking_recurrence` MODIFY `store_id` int unsigned NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_recurrence_store` ON `biz_booking_recurrence` (`store_id`);--> statement-breakpoint
ALTER TABLE `biz_booking_recurrence` ADD CONSTRAINT `fk_recurrence_store` FOREIGN KEY (`store_id`) REFERENCES `sys_store`(`id`) ON DELETE RESTRICT;
