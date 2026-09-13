CREATE TABLE `biz_customer_address` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`customer_id` int unsigned NOT NULL,
	`contact_name` varchar(30) NOT NULL,
	`contact_phone` varchar(20) NOT NULL,
	`province` varchar(30),
	`city` varchar(30),
	`district` varchar(30),
	`detail` varchar(200) NOT NULL,
	`is_default` boolean NOT NULL DEFAULT false,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	`deleted_at` datetime,
	`created_by` int unsigned,
	`updated_by` int unsigned
);
--> statement-breakpoint
CREATE TABLE `biz_customer_favorite` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`customer_id` int unsigned NOT NULL,
	`service_item_id` int unsigned NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	`deleted_at` datetime,
	`created_by` int unsigned,
	`updated_by` int unsigned,
	CONSTRAINT `uq_customer_favorite` UNIQUE INDEX(`customer_id`,`service_item_id`)
);
--> statement-breakpoint
ALTER TABLE `biz_points_goods` ADD `image` varchar(500);--> statement-breakpoint
ALTER TABLE `biz_points_goods` ADD `category` varchar(30);--> statement-breakpoint
CREATE INDEX `idx_customer_address` ON `biz_customer_address` (`customer_id`,`is_default`,`id`);--> statement-breakpoint
CREATE INDEX `idx_customer_favorite_item` ON `biz_customer_favorite` (`service_item_id`);--> statement-breakpoint
CREATE INDEX `idx_points_goods_category` ON `biz_points_goods` (`status`,`category`,`sort`);--> statement-breakpoint
ALTER TABLE `biz_customer_address` ADD CONSTRAINT `fk_customer_address_customer` FOREIGN KEY (`customer_id`) REFERENCES `biz_customer`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `biz_customer_favorite` ADD CONSTRAINT `fk_customer_favorite_customer` FOREIGN KEY (`customer_id`) REFERENCES `biz_customer`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `biz_customer_favorite` ADD CONSTRAINT `fk_customer_favorite_item` FOREIGN KEY (`service_item_id`) REFERENCES `biz_service_item`(`id`) ON DELETE CASCADE;