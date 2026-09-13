CREATE TABLE `biz_feedback` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`customer_id` int unsigned,
	`type` varchar(30) NOT NULL,
	`content` varchar(1000) NOT NULL,
	`contact` varchar(100),
	`is_anonymous` boolean NOT NULL DEFAULT false,
	`status` enum('pending','processing','resolved','closed') NOT NULL DEFAULT 'pending',
	`reply` varchar(500),
	`replied_at` datetime,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	`deleted_at` datetime,
	`created_by` int unsigned,
	`updated_by` int unsigned
);
--> statement-breakpoint
CREATE INDEX `idx_feedback_status` ON `biz_feedback` (`status`,`id`);--> statement-breakpoint
CREATE INDEX `idx_feedback_customer` ON `biz_feedback` (`customer_id`);