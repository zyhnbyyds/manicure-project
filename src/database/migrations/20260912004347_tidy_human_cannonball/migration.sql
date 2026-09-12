CREATE TABLE `biz_coupon_template` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`name` varchar(50) NOT NULL,
	`threshold_amount` int unsigned NOT NULL DEFAULT 0,
	`discount_amount` int unsigned NOT NULL,
	`valid_days` int unsigned NOT NULL DEFAULT 0,
	`valid_from` timestamp,
	`valid_to` timestamp,
	`status` enum('active','disabled') NOT NULL DEFAULT 'active',
	`sort` int NOT NULL DEFAULT 0,
	`remark` varchar(200),
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	`deleted_at` datetime,
	`created_by` int unsigned,
	`updated_by` int unsigned,
	CONSTRAINT `uq_coupon_template_name` UNIQUE INDEX(`name`)
);
--> statement-breakpoint
CREATE TABLE `biz_customer_coupon` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`coupon_no` varchar(32) NOT NULL,
	`customer_id` int unsigned NOT NULL,
	`template_id` int unsigned NOT NULL,
	`discount_amount` int unsigned NOT NULL,
	`threshold_amount` int unsigned NOT NULL DEFAULT 0,
	`status` enum('usable','used','expired','void') NOT NULL DEFAULT 'usable',
	`expire_at` timestamp,
	`used_booking_id` int unsigned,
	`used_at` timestamp,
	`source` varchar(30) NOT NULL DEFAULT 'manual',
	`remark` varchar(200),
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	`deleted_at` datetime,
	`created_by` int unsigned,
	`updated_by` int unsigned,
	CONSTRAINT `uq_customer_coupon_no` UNIQUE INDEX(`coupon_no`),
	CONSTRAINT `uq_customer_coupon_booking` UNIQUE INDEX(`used_booking_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_coupon_template_status` ON `biz_coupon_template` (`status`,`sort`);--> statement-breakpoint
CREATE INDEX `idx_customer_coupon_owner` ON `biz_customer_coupon` (`customer_id`,`status`,`expire_at`);--> statement-breakpoint
ALTER TABLE `biz_customer_coupon` ADD CONSTRAINT `fk_customer_coupon_customer` FOREIGN KEY (`customer_id`) REFERENCES `biz_customer`(`id`) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `biz_customer_coupon` ADD CONSTRAINT `fk_customer_coupon_template` FOREIGN KEY (`template_id`) REFERENCES `biz_coupon_template`(`id`) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `biz_customer_coupon` ADD CONSTRAINT `fk_customer_coupon_booking` FOREIGN KEY (`used_booking_id`) REFERENCES `biz_booking`(`id`) ON DELETE SET NULL;