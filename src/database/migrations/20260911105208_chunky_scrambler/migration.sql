CREATE TABLE `app_wx_subscribe_grant` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`app_wx_user_id` int unsigned NOT NULL,
	`customer_id` int unsigned,
	`template_id` varchar(64) NOT NULL,
	`granted_count` int unsigned NOT NULL DEFAULT 0,
	`last_booking_id` int unsigned,
	`granted_at` datetime NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	`deleted_at` datetime,
	`created_by` int unsigned,
	`updated_by` int unsigned,
	CONSTRAINT `uq_wx_subscribe_grant` UNIQUE INDEX(`app_wx_user_id`,`template_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_wx_subscribe_customer` ON `app_wx_subscribe_grant` (`customer_id`);