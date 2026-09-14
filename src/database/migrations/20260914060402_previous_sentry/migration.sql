ALTER TABLE `biz_staff_schedule_override` ADD `store_id` int unsigned;--> statement-breakpoint
ALTER TABLE `biz_staff_weekly_shift` ADD `store_id` int unsigned;--> statement-breakpoint
CREATE INDEX `idx_override_staff_store_date` ON `biz_staff_schedule_override` (`staff_id`,`store_id`,`date`);--> statement-breakpoint
CREATE INDEX `idx_shift_staff_store_weekday` ON `biz_staff_weekly_shift` (`staff_id`,`store_id`,`weekday`);--> statement-breakpoint
ALTER TABLE `biz_staff_schedule_override` ADD CONSTRAINT `fk_override_store` FOREIGN KEY (`store_id`) REFERENCES `sys_store`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `biz_staff_weekly_shift` ADD CONSTRAINT `fk_shift_store` FOREIGN KEY (`store_id`) REFERENCES `sys_store`(`id`) ON DELETE CASCADE;