ALTER TABLE `app_wx_user` ADD `staff_id` int unsigned;--> statement-breakpoint
ALTER TABLE `app_wx_user` ADD `staff_status` enum('none','pending','active','rejected') DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `app_wx_user` ADD `staff_requested_at` datetime;--> statement-breakpoint
ALTER TABLE `app_wx_user` ADD `staff_decided_at` datetime;--> statement-breakpoint
ALTER TABLE `app_wx_user` ADD `staff_decided_by` int unsigned;--> statement-breakpoint
CREATE INDEX `idx_wx_staff` ON `app_wx_user` (`staff_id`,`staff_status`);--> statement-breakpoint
ALTER TABLE `app_wx_user` ADD CONSTRAINT `fk_wx_user_staff` FOREIGN KEY (`staff_id`) REFERENCES `biz_staff`(`id`) ON DELETE SET NULL;