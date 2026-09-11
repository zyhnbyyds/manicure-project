CREATE TABLE `app_wx_user_bind_log` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`app_wx_user_id` int unsigned NOT NULL,
	`openid` varchar(64) NOT NULL,
	`phone` varchar(20),
	`customer_id_before` int unsigned,
	`customer_id_after` int unsigned,
	`source` enum('bind_phone') NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	`deleted_at` datetime,
	`created_by` int unsigned,
	`updated_by` int unsigned
);
--> statement-breakpoint
CREATE INDEX `idx_wx_bind_user` ON `app_wx_user_bind_log` (`app_wx_user_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_wx_bind_customer` ON `app_wx_user_bind_log` (`customer_id_after`);