CREATE TABLE `app_wx_user` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`openid` varchar(64) NOT NULL,
	`unionid` varchar(64),
	`customer_id` int unsigned,
	`nickname` varchar(50),
	`avatar` varchar(500),
	`phone` varchar(20),
	`last_login_at` datetime,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	`deleted_at` datetime,
	`created_by` int unsigned,
	`updated_by` int unsigned,
	CONSTRAINT `uq_wx_openid` UNIQUE INDEX(`openid`)
);
--> statement-breakpoint
CREATE TABLE `biz_booking_item` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`booking_id` int unsigned NOT NULL,
	`service_item_id` int unsigned NOT NULL,
	`name` varchar(50) NOT NULL,
	`duration_minutes` int unsigned NOT NULL,
	`price` int unsigned NOT NULL DEFAULT 0,
	`sort` int NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE `biz_booking_recurrence` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`name` varchar(50),
	`customer_id` int unsigned NOT NULL,
	`staff_id` int unsigned NOT NULL,
	`service_item_ids` json NOT NULL,
	`weekday` tinyint unsigned NOT NULL,
	`start_time` time NOT NULL,
	`duration_minutes` int unsigned NOT NULL,
	`start_date` date NOT NULL,
	`end_date` date,
	`generate_days` int unsigned NOT NULL DEFAULT 30,
	`generated_until` date,
	`status` enum('active','paused','stopped') NOT NULL DEFAULT 'active',
	`last_run_at` datetime,
	`conflict_policy` enum('skip','notify') NOT NULL DEFAULT 'notify',
	`remark` varchar(200),
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	`deleted_at` datetime,
	`created_by` int unsigned,
	`updated_by` int unsigned
);
--> statement-breakpoint
CREATE TABLE `biz_booking` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`booking_no` varchar(32) NOT NULL,
	`customer_id` int unsigned NOT NULL,
	`staff_id` int unsigned NOT NULL,
	`start_at` datetime NOT NULL,
	`end_at` datetime NOT NULL,
	`duration_minutes` int unsigned NOT NULL,
	`buffer_minutes` int unsigned NOT NULL DEFAULT 0,
	`original_price` int unsigned NOT NULL DEFAULT 0,
	`level_discount_permille` int unsigned NOT NULL DEFAULT 1000,
	`level_discount_amount` int unsigned NOT NULL DEFAULT 0,
	`points_discount_amount` int unsigned NOT NULL DEFAULT 0,
	`adjust_amount` int NOT NULL DEFAULT 0,
	`adjust_reason` varchar(200),
	`payable_amount` int unsigned NOT NULL DEFAULT 0,
	`deposit_amount` int unsigned NOT NULL DEFAULT 0,
	`paid_amount` int unsigned NOT NULL DEFAULT 0,
	`due_amount` int unsigned NOT NULL DEFAULT 0,
	`pay_status` enum('unpaid','partial','paid','refunded','credit') NOT NULL DEFAULT 'unpaid',
	`pay_channel_summary` varchar(64),
	`settled_at` datetime,
	`credit_account_id` int unsigned,
	`recurrence_id` int unsigned,
	`member_card_id` int unsigned,
	`refund_amount` int unsigned NOT NULL DEFAULT 0,
	`refunded_at` datetime,
	`status` enum('pending','confirmed','arrived','completed','cancelled','no_show') NOT NULL DEFAULT 'confirmed',
	`channel` enum('admin','miniapp') NOT NULL DEFAULT 'admin',
	`customer_name` varchar(50) NOT NULL,
	`customer_phone` varchar(20),
	`remark` varchar(500),
	`cancel_reason` varchar(200),
	`confirmed_at` datetime,
	`arrived_at` datetime,
	`finished_at` datetime,
	`cancelled_at` datetime,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	`deleted_at` datetime,
	`created_by` int unsigned,
	`updated_by` int unsigned,
	CONSTRAINT `uq_booking_no` UNIQUE INDEX(`booking_no`),
	CONSTRAINT `uq_booking_recurrence_start` UNIQUE INDEX(`recurrence_id`,`start_at`)
);
--> statement-breakpoint
CREATE TABLE `biz_commission_record` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`booking_id` int unsigned NOT NULL,
	`booking_item_id` int unsigned NOT NULL,
	`staff_id` int unsigned NOT NULL,
	`rule_id` int unsigned,
	`base_amount` int unsigned NOT NULL,
	`amount` int unsigned NOT NULL,
	`period` char(6) NOT NULL,
	`status` enum('accrued','settled','reversed') NOT NULL DEFAULT 'accrued',
	`settled_at` datetime,
	`settle_batch` varchar(32),
	`remark` varchar(200),
	`created_by` int unsigned,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE `biz_commission_rule` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`name` varchar(50) NOT NULL,
	`scope` enum('staff','category','service_item') NOT NULL,
	`target_id` int unsigned,
	`staff_id` int unsigned,
	`category` varchar(30),
	`permille` int unsigned NOT NULL DEFAULT 0,
	`fixed_amount` int unsigned NOT NULL DEFAULT 0,
	`base` enum('payable','paid','original') NOT NULL DEFAULT 'paid',
	`effective_from` date NOT NULL,
	`effective_to` date,
	`status` enum('active','disabled') NOT NULL DEFAULT 'active',
	`sort` int NOT NULL DEFAULT 0,
	`remark` varchar(200),
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	`deleted_at` datetime,
	`created_by` int unsigned,
	`updated_by` int unsigned
);
--> statement-breakpoint
CREATE TABLE `biz_credit_account` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`name` varchar(50) NOT NULL,
	`type` enum('customer','company','staff') NOT NULL,
	`customer_id` int unsigned,
	`contact` varchar(50),
	`phone` varchar(20),
	`credit_limit` int unsigned NOT NULL DEFAULT 0,
	`used_amount` int unsigned NOT NULL DEFAULT 0,
	`settle_day` tinyint unsigned NOT NULL DEFAULT 0,
	`status` enum('active','disabled') NOT NULL DEFAULT 'active',
	`remark` varchar(500),
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	`deleted_at` datetime,
	`created_by` int unsigned,
	`updated_by` int unsigned,
	CONSTRAINT `uq_credit_account_name` UNIQUE INDEX(`name`)
);
--> statement-breakpoint
CREATE TABLE `biz_customer` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`name` varchar(50) NOT NULL,
	`phone` varchar(20),
	`gender` enum('unknown','male','female') NOT NULL DEFAULT 'unknown',
	`birthday` date,
	`remark` varchar(500),
	`visit_count` int unsigned NOT NULL DEFAULT 0,
	`last_visit_at` datetime,
	`level_id` int unsigned,
	`member_no` varchar(32),
	`member_since` datetime,
	`total_spent` int unsigned NOT NULL DEFAULT 0,
	`points` int unsigned NOT NULL DEFAULT 0,
	`points_total` int unsigned NOT NULL DEFAULT 0,
	`balance_principal` int unsigned NOT NULL DEFAULT 0,
	`balance_bonus` int unsigned NOT NULL DEFAULT 0,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	`deleted_at` datetime,
	`created_by` int unsigned,
	`updated_by` int unsigned,
	CONSTRAINT `uq_customer_phone` UNIQUE INDEX(`phone`),
	CONSTRAINT `uq_customer_member_no` UNIQUE INDEX(`member_no`)
);
--> statement-breakpoint
CREATE TABLE `biz_member_card_log` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`card_id` int unsigned NOT NULL,
	`booking_id` int unsigned,
	`service_item_id` int unsigned NOT NULL,
	`type` enum('use','revert') NOT NULL,
	`times` int unsigned NOT NULL DEFAULT 1,
	`remark` varchar(200),
	`created_by` int unsigned,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE `biz_member_card_type_item` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`card_type_id` int unsigned NOT NULL,
	`service_item_id` int unsigned NOT NULL,
	`sort` int NOT NULL DEFAULT 0,
	CONSTRAINT `uq_card_type_item` UNIQUE INDEX(`card_type_id`,`service_item_id`)
);
--> statement-breakpoint
CREATE TABLE `biz_member_card_type` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`name` varchar(50) NOT NULL,
	`price` int unsigned NOT NULL,
	`total_times` int unsigned NOT NULL,
	`valid_days` int unsigned NOT NULL DEFAULT 0,
	`status` enum('active','disabled') NOT NULL DEFAULT 'active',
	`sort` int NOT NULL DEFAULT 0,
	`remark` varchar(200),
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	`deleted_at` datetime,
	`created_by` int unsigned,
	`updated_by` int unsigned,
	CONSTRAINT `uq_card_type_name` UNIQUE INDEX(`name`)
);
--> statement-breakpoint
CREATE TABLE `biz_member_card` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`card_no` varchar(32) NOT NULL,
	`customer_id` int unsigned NOT NULL,
	`card_type_id` int unsigned NOT NULL,
	`card_name` varchar(50) NOT NULL,
	`total_times` int unsigned NOT NULL,
	`used_times` int unsigned NOT NULL DEFAULT 0,
	`price` int unsigned NOT NULL DEFAULT 0,
	`pay_channel` enum('cash','wechat','alipay','balance') NOT NULL,
	`purchased_at` datetime NOT NULL,
	`expire_at` datetime,
	`status` enum('active','used_up','expired','refunded') NOT NULL DEFAULT 'active',
	`remark` varchar(200),
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	`deleted_at` datetime,
	`created_by` int unsigned,
	`updated_by` int unsigned,
	CONSTRAINT `uq_member_card_no` UNIQUE INDEX(`card_no`)
);
--> statement-breakpoint
CREATE TABLE `biz_member_level` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`name` varchar(30) NOT NULL,
	`discount_permille` int unsigned NOT NULL DEFAULT 1000,
	`upgrade_amount` int unsigned NOT NULL DEFAULT 0,
	`sort` int NOT NULL DEFAULT 0,
	`status` enum('active','disabled') NOT NULL DEFAULT 'active',
	`remark` varchar(200),
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	`deleted_at` datetime,
	`created_by` int unsigned,
	`updated_by` int unsigned,
	CONSTRAINT `uq_level_name` UNIQUE INDEX(`name`)
);
--> statement-breakpoint
CREATE TABLE `biz_member_transaction` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`customer_id` int unsigned NOT NULL,
	`type` enum('recharge','consume','refund','card_buy','card_use','card_revert','points_earn','points_spend','points_redeem','level_change','adjust') NOT NULL,
	`amount` int NOT NULL DEFAULT 0,
	`balance_delta_principal` int NOT NULL DEFAULT 0,
	`balance_delta_bonus` int NOT NULL DEFAULT 0,
	`balance_principal_after` int unsigned NOT NULL DEFAULT 0,
	`balance_bonus_after` int unsigned NOT NULL DEFAULT 0,
	`points_delta` int NOT NULL DEFAULT 0,
	`points_after` int unsigned NOT NULL DEFAULT 0,
	`pay_channel` enum('cash','wechat','alipay','balance','card'),
	`booking_id` int unsigned,
	`card_id` int unsigned,
	`plan_id` int unsigned,
	`reversal_of` int unsigned,
	`remark` varchar(200),
	`created_by` int unsigned,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE `biz_payment_diff` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`bill_date` date NOT NULL,
	`channel` enum('wxpay_native','alipay_qr') NOT NULL,
	`out_trade_no` varchar(64),
	`transaction_id` varchar(64),
	`system_amount` int unsigned NOT NULL DEFAULT 0,
	`channel_amount` int unsigned NOT NULL DEFAULT 0,
	`diff_type` enum('missing_in_system','missing_in_channel','amount_mismatch','status_mismatch') NOT NULL,
	`status` enum('pending','resolved','ignored') NOT NULL DEFAULT 'pending',
	`handle_by` int unsigned,
	`handled_at` datetime,
	`remark` varchar(200),
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	`deleted_at` datetime,
	`created_by` int unsigned,
	`updated_by` int unsigned,
	CONSTRAINT `uq_payment_diff` UNIQUE INDEX(`bill_date`,`channel`,`transaction_id`,`diff_type`)
);
--> statement-breakpoint
CREATE TABLE `biz_payment_log` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`payment_id` int unsigned NOT NULL,
	`event` enum('create','callback','query','close','refund','callback_invalid') NOT NULL,
	`http_status` int,
	`raw` json,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE `biz_payment` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`payment_no` varchar(32) NOT NULL,
	`out_trade_no` varchar(64) NOT NULL,
	`booking_id` int unsigned,
	`customer_id` int unsigned NOT NULL,
	`purpose` enum('deposit','final','recharge','card_buy','credit_settle') NOT NULL,
	`channel` enum('wxpay_native','alipay_qr','cash','wechat_offline','alipay_offline','balance','card','credit') NOT NULL,
	`amount` int unsigned NOT NULL,
	`received_amount` int unsigned NOT NULL DEFAULT 0,
	`status` enum('pending','success','failed','closed','refunded','partial_refunded') NOT NULL DEFAULT 'pending',
	`code_url` varchar(512),
	`transaction_id` varchar(64),
	`paid_at` datetime,
	`expire_at` datetime,
	`refunded_amount` int unsigned NOT NULL DEFAULT 0,
	`callback_at` datetime,
	`remark` varchar(200),
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	`deleted_at` datetime,
	`created_by` int unsigned,
	`updated_by` int unsigned,
	CONSTRAINT `uq_payment_no` UNIQUE INDEX(`payment_no`),
	CONSTRAINT `uq_payment_out_trade_no` UNIQUE INDEX(`out_trade_no`)
);
--> statement-breakpoint
CREATE TABLE `biz_points_goods` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`name` varchar(50) NOT NULL,
	`card_type_id` int unsigned NOT NULL,
	`points` int unsigned NOT NULL,
	`stock` int NOT NULL DEFAULT -1,
	`per_limit` int unsigned NOT NULL DEFAULT 0,
	`status` enum('active','disabled') NOT NULL DEFAULT 'active',
	`sort` int NOT NULL DEFAULT 0,
	`remark` varchar(200),
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	`deleted_at` datetime,
	`created_by` int unsigned,
	`updated_by` int unsigned,
	CONSTRAINT `uq_points_goods_name` UNIQUE INDEX(`name`)
);
--> statement-breakpoint
CREATE TABLE `biz_points_redeem` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`redeem_no` varchar(32) NOT NULL,
	`customer_id` int unsigned NOT NULL,
	`goods_id` int unsigned NOT NULL,
	`points` int unsigned NOT NULL,
	`member_card_id` int unsigned,
	`status` enum('success','reverted') NOT NULL DEFAULT 'success',
	`remark` varchar(200),
	`created_by` int unsigned,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `uq_points_redeem_no` UNIQUE INDEX(`redeem_no`)
);
--> statement-breakpoint
CREATE TABLE `biz_receivable_payment` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`receivable_id` int unsigned NOT NULL,
	`amount` int unsigned NOT NULL,
	`pay_channel` enum('cash','wechat_offline','alipay_offline','balance','wxpay_native','alipay_qr') NOT NULL,
	`payment_id` int unsigned,
	`paid_at` datetime NOT NULL,
	`remark` varchar(200),
	`created_by` int unsigned,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE `biz_receivable` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`receivable_no` varchar(32) NOT NULL,
	`credit_account_id` int unsigned NOT NULL,
	`booking_id` int unsigned,
	`customer_id` int unsigned,
	`amount` int unsigned NOT NULL,
	`settled_amount` int unsigned NOT NULL DEFAULT 0,
	`due_date` date,
	`status` enum('open','partial','settled','overdue','cancelled') NOT NULL DEFAULT 'open',
	`settled_at` datetime,
	`remark` varchar(200),
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	`deleted_at` datetime,
	`created_by` int unsigned,
	`updated_by` int unsigned,
	CONSTRAINT `uq_receivable_no` UNIQUE INDEX(`receivable_no`)
);
--> statement-breakpoint
CREATE TABLE `biz_recharge_plan` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`name` varchar(30) NOT NULL,
	`pay_amount` int unsigned NOT NULL,
	`bonus_amount` int unsigned NOT NULL DEFAULT 0,
	`status` enum('active','disabled') NOT NULL DEFAULT 'active',
	`sort` int NOT NULL DEFAULT 0,
	`remark` varchar(200),
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	`deleted_at` datetime,
	`created_by` int unsigned,
	`updated_by` int unsigned,
	CONSTRAINT `uq_recharge_plan_name` UNIQUE INDEX(`name`)
);
--> statement-breakpoint
CREATE TABLE `biz_refund_policy` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`name` varchar(50) NOT NULL,
	`hours_before` int unsigned NOT NULL,
	`refund_permille` int unsigned NOT NULL,
	`min_amount` int unsigned NOT NULL DEFAULT 0,
	`status` enum('active','disabled') NOT NULL DEFAULT 'active',
	`sort` int NOT NULL DEFAULT 0,
	`remark` varchar(200),
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	`deleted_at` datetime,
	`created_by` int unsigned,
	`updated_by` int unsigned,
	CONSTRAINT `uq_refund_policy_name` UNIQUE INDEX(`name`)
);
--> statement-breakpoint
CREATE TABLE `biz_refund` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`refund_no` varchar(32) NOT NULL,
	`payment_id` int unsigned NOT NULL,
	`booking_id` int unsigned,
	`customer_id` int unsigned NOT NULL,
	`amount` int unsigned NOT NULL,
	`actual_amount` int unsigned NOT NULL DEFAULT 0,
	`deduct_amount` int unsigned NOT NULL DEFAULT 0,
	`mode` enum('original','cash','balance') NOT NULL,
	`policy_id` int unsigned,
	`liable` enum('store','customer','force_majeure') NOT NULL DEFAULT 'store',
	`reason` varchar(200) NOT NULL,
	`status` enum('pending','approved','rejected','success','failed') NOT NULL DEFAULT 'pending',
	`apply_by` int unsigned NOT NULL,
	`apply_at` datetime NOT NULL,
	`approve_by` int unsigned,
	`approve_at` datetime,
	`reject_reason` varchar(200),
	`channel_refund_id` varchar(64),
	`refunded_at` datetime,
	`remark` varchar(200),
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	`deleted_at` datetime,
	`created_by` int unsigned,
	`updated_by` int unsigned,
	CONSTRAINT `uq_refund_no` UNIQUE INDEX(`refund_no`)
);
--> statement-breakpoint
CREATE TABLE `biz_review` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`booking_id` int unsigned NOT NULL,
	`customer_id` int unsigned NOT NULL,
	`staff_id` int unsigned NOT NULL,
	`score` tinyint unsigned NOT NULL,
	`content` varchar(1000),
	`images` json,
	`is_public` boolean NOT NULL DEFAULT true,
	`reply` varchar(500),
	`replied_at` datetime,
	`status` enum('published','hidden') NOT NULL DEFAULT 'published',
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	`deleted_at` datetime,
	`created_by` int unsigned,
	`updated_by` int unsigned,
	CONSTRAINT `uq_review_booking` UNIQUE INDEX(`booking_id`)
);
--> statement-breakpoint
CREATE TABLE `biz_service_item` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`name` varchar(50) NOT NULL,
	`category` varchar(30),
	`duration_minutes` int unsigned NOT NULL,
	`buffer_minutes` int unsigned NOT NULL DEFAULT 0,
	`price` int unsigned NOT NULL DEFAULT 0,
	`description` varchar(500),
	`image` varchar(500),
	`status` enum('active','disabled') NOT NULL DEFAULT 'active',
	`sort` int NOT NULL DEFAULT 0,
	`remark` varchar(500),
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	`deleted_at` datetime,
	`created_by` int unsigned,
	`updated_by` int unsigned
);
--> statement-breakpoint
CREATE TABLE `biz_staff_schedule_override` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`staff_id` int unsigned NOT NULL,
	`date` date NOT NULL,
	`type` enum('off','custom') NOT NULL,
	`start_time` time,
	`end_time` time,
	`reason` varchar(200),
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	`deleted_at` datetime,
	`created_by` int unsigned,
	`updated_by` int unsigned
);
--> statement-breakpoint
CREATE TABLE `biz_staff_service_item` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`staff_id` int unsigned NOT NULL,
	`service_item_id` int unsigned NOT NULL,
	`sort` int NOT NULL DEFAULT 0,
	CONSTRAINT `uq_staff_service_item` UNIQUE INDEX(`staff_id`,`service_item_id`)
);
--> statement-breakpoint
CREATE TABLE `biz_staff_weekly_shift` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`staff_id` int unsigned NOT NULL,
	`weekday` tinyint unsigned NOT NULL,
	`start_time` time NOT NULL,
	`end_time` time NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	`deleted_at` datetime,
	`created_by` int unsigned,
	`updated_by` int unsigned
);
--> statement-breakpoint
CREATE TABLE `biz_staff` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`user_id` int unsigned,
	`nickname` varchar(50) NOT NULL,
	`avatar` varchar(500),
	`phone` varchar(20),
	`bio` varchar(500),
	`status` enum('active','disabled') NOT NULL DEFAULT 'active',
	`sort` int NOT NULL DEFAULT 0,
	`remark` varchar(500),
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	`deleted_at` datetime,
	`created_by` int unsigned,
	`updated_by` int unsigned
);
--> statement-breakpoint
CREATE TABLE `sys_notice_log` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`template_code` varchar(50) NOT NULL,
	`channel` enum('sms','site') NOT NULL,
	`recipient_type` enum('customer','user') NOT NULL,
	`recipient_id` int unsigned NOT NULL,
	`phone` varchar(20),
	`title` varchar(100),
	`content` varchar(1000) NOT NULL,
	`status` enum('pending','success','failed','skipped') NOT NULL DEFAULT 'pending',
	`provider` varchar(30),
	`provider_msg_id` varchar(64),
	`error` varchar(500),
	`retry_count` tinyint unsigned NOT NULL DEFAULT 0,
	`sent_at` datetime,
	`read_at` datetime,
	`booking_id` int unsigned,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE `sys_notice_template` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`code` varchar(50) NOT NULL,
	`name` varchar(50) NOT NULL,
	`channel` enum('sms','site','both') NOT NULL DEFAULT 'both',
	`title` varchar(100),
	`content` varchar(1000) NOT NULL,
	`variables` json,
	`status` enum('active','disabled') NOT NULL DEFAULT 'active',
	`remark` varchar(200),
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	`deleted_at` datetime,
	`created_by` int unsigned,
	`updated_by` int unsigned,
	CONSTRAINT `uq_notice_template_code` UNIQUE INDEX(`code`)
);
--> statement-breakpoint
CREATE INDEX `idx_wx_unionid` ON `app_wx_user` (`unionid`);--> statement-breakpoint
CREATE INDEX `idx_wx_customer` ON `app_wx_user` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_booking_item_booking` ON `biz_booking_item` (`booking_id`);--> statement-breakpoint
CREATE INDEX `idx_booking_item_service` ON `biz_booking_item` (`service_item_id`);--> statement-breakpoint
CREATE INDEX `idx_recurrence_status` ON `biz_booking_recurrence` (`status`,`generated_until`);--> statement-breakpoint
CREATE INDEX `idx_recurrence_customer` ON `biz_booking_recurrence` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_booking_staff_time` ON `biz_booking` (`staff_id`,`start_at`,`end_at`);--> statement-breakpoint
CREATE INDEX `idx_booking_customer` ON `biz_booking` (`customer_id`,`start_at`);--> statement-breakpoint
CREATE INDEX `idx_booking_status_start` ON `biz_booking` (`status`,`start_at`);--> statement-breakpoint
CREATE INDEX `idx_booking_status_end` ON `biz_booking` (`status`,`end_at`);--> statement-breakpoint
CREATE INDEX `idx_booking_pay` ON `biz_booking` (`pay_status`,`start_at`);--> statement-breakpoint
CREATE INDEX `idx_booking_credit` ON `biz_booking` (`credit_account_id`,`pay_status`);--> statement-breakpoint
CREATE INDEX `idx_booking_recurrence` ON `biz_booking` (`recurrence_id`);--> statement-breakpoint
CREATE INDEX `idx_comm_record_staff_period` ON `biz_commission_record` (`staff_id`,`period`,`status`);--> statement-breakpoint
CREATE INDEX `idx_comm_record_booking` ON `biz_commission_record` (`booking_id`);--> statement-breakpoint
CREATE INDEX `idx_commission_rule_scope` ON `biz_commission_rule` (`scope`,`status`,`sort`);--> statement-breakpoint
CREATE INDEX `idx_commission_rule_staff` ON `biz_commission_rule` (`staff_id`);--> statement-breakpoint
CREATE INDEX `idx_credit_account_type` ON `biz_credit_account` (`type`,`status`);--> statement-breakpoint
CREATE INDEX `idx_customer_level` ON `biz_customer` (`level_id`);--> statement-breakpoint
CREATE INDEX `idx_customer_name` ON `biz_customer` (`name`);--> statement-breakpoint
CREATE INDEX `idx_card_log_card` ON `biz_member_card_log` (`card_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_card_log_booking` ON `biz_member_card_log` (`booking_id`);--> statement-breakpoint
CREATE INDEX `idx_card_type_status_sort` ON `biz_member_card_type` (`status`,`sort`);--> statement-breakpoint
CREATE INDEX `idx_card_customer` ON `biz_member_card` (`customer_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_card_expire` ON `biz_member_card` (`status`,`expire_at`);--> statement-breakpoint
CREATE INDEX `idx_level_status_sort` ON `biz_member_level` (`status`,`sort`);--> statement-breakpoint
CREATE INDEX `idx_txn_customer` ON `biz_member_transaction` (`customer_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_txn_booking` ON `biz_member_transaction` (`booking_id`);--> statement-breakpoint
CREATE INDEX `idx_txn_type_created` ON `biz_member_transaction` (`type`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_payment_diff_status` ON `biz_payment_diff` (`status`,`bill_date`);--> statement-breakpoint
CREATE INDEX `idx_payment_log_payment` ON `biz_payment_log` (`payment_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_payment_booking` ON `biz_payment` (`booking_id`);--> statement-breakpoint
CREATE INDEX `idx_payment_customer` ON `biz_payment` (`customer_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_payment_status` ON `biz_payment` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_payment_txn` ON `biz_payment` (`transaction_id`);--> statement-breakpoint
CREATE INDEX `idx_points_goods_status` ON `biz_points_goods` (`status`,`sort`);--> statement-breakpoint
CREATE INDEX `idx_points_redeem_customer` ON `biz_points_redeem` (`customer_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_recv_pay_receivable` ON `biz_receivable_payment` (`receivable_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_receivable_account` ON `biz_receivable` (`credit_account_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_receivable_due` ON `biz_receivable` (`status`,`due_date`);--> statement-breakpoint
CREATE INDEX `idx_refund_policy_status_sort` ON `biz_refund_policy` (`status`,`sort`);--> statement-breakpoint
CREATE INDEX `idx_refund_payment` ON `biz_refund` (`payment_id`);--> statement-breakpoint
CREATE INDEX `idx_refund_status` ON `biz_refund` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_refund_booking` ON `biz_refund` (`booking_id`);--> statement-breakpoint
CREATE INDEX `idx_review_staff` ON `biz_review` (`staff_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `idx_review_customer` ON `biz_review` (`customer_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_service_item_status` ON `biz_service_item` (`status`,`sort`);--> statement-breakpoint
CREATE INDEX `idx_override_staff_date` ON `biz_staff_schedule_override` (`staff_id`,`date`);--> statement-breakpoint
CREATE INDEX `idx_shift_staff_weekday` ON `biz_staff_weekly_shift` (`staff_id`,`weekday`);--> statement-breakpoint
CREATE INDEX `idx_staff_user` ON `biz_staff` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_staff_status` ON `biz_staff` (`status`,`sort`);--> statement-breakpoint
CREATE INDEX `idx_notice_log_status` ON `sys_notice_log` (`status`,`retry_count`,`id`);--> statement-breakpoint
CREATE INDEX `idx_notice_log_recipient` ON `sys_notice_log` (`recipient_type`,`recipient_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_notice_log_booking` ON `sys_notice_log` (`booking_id`);--> statement-breakpoint
ALTER TABLE `app_wx_user` ADD CONSTRAINT `fk_wx_user_customer` FOREIGN KEY (`customer_id`) REFERENCES `biz_customer`(`id`) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `biz_booking_item` ADD CONSTRAINT `fk_booking_item_booking` FOREIGN KEY (`booking_id`) REFERENCES `biz_booking`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `biz_booking_item` ADD CONSTRAINT `fk_booking_item_service` FOREIGN KEY (`service_item_id`) REFERENCES `biz_service_item`(`id`) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `biz_booking_recurrence` ADD CONSTRAINT `fk_recurrence_customer` FOREIGN KEY (`customer_id`) REFERENCES `biz_customer`(`id`) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `biz_booking_recurrence` ADD CONSTRAINT `fk_recurrence_staff` FOREIGN KEY (`staff_id`) REFERENCES `biz_staff`(`id`) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `biz_booking` ADD CONSTRAINT `fk_booking_customer` FOREIGN KEY (`customer_id`) REFERENCES `biz_customer`(`id`) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `biz_booking` ADD CONSTRAINT `fk_booking_staff` FOREIGN KEY (`staff_id`) REFERENCES `biz_staff`(`id`) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `biz_booking` ADD CONSTRAINT `fk_booking_credit_account` FOREIGN KEY (`credit_account_id`) REFERENCES `biz_credit_account`(`id`) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `biz_booking` ADD CONSTRAINT `fk_booking_member_card` FOREIGN KEY (`member_card_id`) REFERENCES `biz_member_card`(`id`) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `biz_booking` ADD CONSTRAINT `fk_booking_recurrence` FOREIGN KEY (`recurrence_id`) REFERENCES `biz_booking_recurrence`(`id`) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `biz_commission_record` ADD CONSTRAINT `fk_comm_record_booking` FOREIGN KEY (`booking_id`) REFERENCES `biz_booking`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `biz_commission_record` ADD CONSTRAINT `fk_comm_record_booking_item` FOREIGN KEY (`booking_item_id`) REFERENCES `biz_booking_item`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `biz_commission_record` ADD CONSTRAINT `fk_comm_record_staff` FOREIGN KEY (`staff_id`) REFERENCES `biz_staff`(`id`) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `biz_commission_record` ADD CONSTRAINT `fk_comm_record_rule` FOREIGN KEY (`rule_id`) REFERENCES `biz_commission_rule`(`id`) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `biz_credit_account` ADD CONSTRAINT `fk_credit_account_customer` FOREIGN KEY (`customer_id`) REFERENCES `biz_customer`(`id`) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `biz_customer` ADD CONSTRAINT `fk_customer_level` FOREIGN KEY (`level_id`) REFERENCES `biz_member_level`(`id`) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `biz_member_card_log` ADD CONSTRAINT `fk_card_log_card` FOREIGN KEY (`card_id`) REFERENCES `biz_member_card`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `biz_member_card_log` ADD CONSTRAINT `fk_card_log_booking` FOREIGN KEY (`booking_id`) REFERENCES `biz_booking`(`id`) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `biz_member_card_type_item` ADD CONSTRAINT `fk_card_type_item_type` FOREIGN KEY (`card_type_id`) REFERENCES `biz_member_card_type`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `biz_member_card_type_item` ADD CONSTRAINT `fk_card_type_item_service` FOREIGN KEY (`service_item_id`) REFERENCES `biz_service_item`(`id`) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `biz_member_card` ADD CONSTRAINT `fk_card_customer` FOREIGN KEY (`customer_id`) REFERENCES `biz_customer`(`id`) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `biz_member_card` ADD CONSTRAINT `fk_card_type` FOREIGN KEY (`card_type_id`) REFERENCES `biz_member_card_type`(`id`) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `biz_member_transaction` ADD CONSTRAINT `fk_txn_customer` FOREIGN KEY (`customer_id`) REFERENCES `biz_customer`(`id`) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `biz_member_transaction` ADD CONSTRAINT `fk_txn_booking` FOREIGN KEY (`booking_id`) REFERENCES `biz_booking`(`id`) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `biz_member_transaction` ADD CONSTRAINT `fk_txn_card` FOREIGN KEY (`card_id`) REFERENCES `biz_member_card`(`id`) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `biz_member_transaction` ADD CONSTRAINT `fk_txn_plan` FOREIGN KEY (`plan_id`) REFERENCES `biz_recharge_plan`(`id`) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `biz_payment_log` ADD CONSTRAINT `fk_payment_log_payment` FOREIGN KEY (`payment_id`) REFERENCES `biz_payment`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `biz_payment` ADD CONSTRAINT `fk_payment_booking` FOREIGN KEY (`booking_id`) REFERENCES `biz_booking`(`id`) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `biz_payment` ADD CONSTRAINT `fk_payment_customer` FOREIGN KEY (`customer_id`) REFERENCES `biz_customer`(`id`) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `biz_points_goods` ADD CONSTRAINT `fk_points_goods_card_type` FOREIGN KEY (`card_type_id`) REFERENCES `biz_member_card_type`(`id`) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `biz_points_redeem` ADD CONSTRAINT `fk_points_redeem_customer` FOREIGN KEY (`customer_id`) REFERENCES `biz_customer`(`id`) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `biz_points_redeem` ADD CONSTRAINT `fk_points_redeem_goods` FOREIGN KEY (`goods_id`) REFERENCES `biz_points_goods`(`id`) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `biz_points_redeem` ADD CONSTRAINT `fk_points_redeem_card` FOREIGN KEY (`member_card_id`) REFERENCES `biz_member_card`(`id`) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `biz_receivable_payment` ADD CONSTRAINT `fk_recv_pay_receivable` FOREIGN KEY (`receivable_id`) REFERENCES `biz_receivable`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `biz_receivable` ADD CONSTRAINT `fk_receivable_account` FOREIGN KEY (`credit_account_id`) REFERENCES `biz_credit_account`(`id`) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `biz_receivable` ADD CONSTRAINT `fk_receivable_booking` FOREIGN KEY (`booking_id`) REFERENCES `biz_booking`(`id`) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `biz_refund` ADD CONSTRAINT `fk_refund_payment` FOREIGN KEY (`payment_id`) REFERENCES `biz_payment`(`id`) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `biz_refund` ADD CONSTRAINT `fk_refund_booking` FOREIGN KEY (`booking_id`) REFERENCES `biz_booking`(`id`) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `biz_review` ADD CONSTRAINT `fk_review_booking` FOREIGN KEY (`booking_id`) REFERENCES `biz_booking`(`id`) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `biz_review` ADD CONSTRAINT `fk_review_staff` FOREIGN KEY (`staff_id`) REFERENCES `biz_staff`(`id`) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `biz_staff_schedule_override` ADD CONSTRAINT `fk_override_staff` FOREIGN KEY (`staff_id`) REFERENCES `biz_staff`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `biz_staff_service_item` ADD CONSTRAINT `fk_staff_service_staff` FOREIGN KEY (`staff_id`) REFERENCES `biz_staff`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `biz_staff_service_item` ADD CONSTRAINT `fk_staff_service_item` FOREIGN KEY (`service_item_id`) REFERENCES `biz_service_item`(`id`) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `biz_staff_weekly_shift` ADD CONSTRAINT `fk_shift_staff` FOREIGN KEY (`staff_id`) REFERENCES `biz_staff`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `biz_staff` ADD CONSTRAINT `fk_staff_user` FOREIGN KEY (`user_id`) REFERENCES `sys_user`(`id`) ON DELETE SET NULL;