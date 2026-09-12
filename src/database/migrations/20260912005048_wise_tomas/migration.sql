ALTER TABLE `biz_booking` ADD `coupon_id` int unsigned;--> statement-breakpoint
ALTER TABLE `biz_booking` ADD `coupon_discount_amount` int unsigned DEFAULT 0 NOT NULL;