CREATE TABLE `sys_store` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`code` varchar(32) NOT NULL,
	`name` varchar(50) NOT NULL,
	`name_en` varchar(50),
	`phone` varchar(20),
	`address` varchar(200),
	`hours` varchar(50),
	`latitude` double,
	`longitude` double,
	`notice` varchar(500),
	`timezone` varchar(64),
	`status` enum('active','disabled') NOT NULL DEFAULT 'active',
	`sort` int NOT NULL DEFAULT 0,
	`is_default` boolean NOT NULL DEFAULT false,
	`remark` varchar(200),
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	`deleted_at` datetime,
	`created_by` int unsigned,
	`updated_by` int unsigned,
	CONSTRAINT `uq_store_code` UNIQUE INDEX(`code`)
);
--> statement-breakpoint
CREATE INDEX `idx_store_status` ON `sys_store` (`status`,`sort`,`id`);
--> statement-breakpoint
-- 数据回填（手工追加；drizzle 不会生成）：把现有的**单店配置**（`sys_config` 的 `biz.shop.*`）
-- 落成一条「默认门店」。为什么必须在迁移里做而不是只靠 seed：下一批会给单据/流水加
-- `store_id`，历史行需要有门店可指；seed 是可跳过可重跑的，迁移才是必然执行一次的那个。
-- 已经建过门店的库（`sys_store` 非空）不会被覆盖 —— 运营改过的值不归迁移管。
INSERT INTO `sys_store`
	(`code`, `name`, `name_en`, `phone`, `address`, `hours`, `latitude`, `longitude`, `notice`, `sort`, `is_default`, `remark`)
SELECT
	'MAIN',
	COALESCE(NULLIF((SELECT `value` FROM `sys_config` WHERE `config_key` = 'biz.shop.name' LIMIT 1), ''), '美甲小铺'),
	(SELECT `value` FROM `sys_config` WHERE `config_key` = 'biz.shop.nameEn' LIMIT 1),
	(SELECT `value` FROM `sys_config` WHERE `config_key` = 'biz.shop.phone' LIMIT 1),
	(SELECT `value` FROM `sys_config` WHERE `config_key` = 'biz.shop.address' LIMIT 1),
	(SELECT `value` FROM `sys_config` WHERE `config_key` = 'biz.shop.hours' LIMIT 1),
	(SELECT `value` FROM `sys_config` WHERE `config_key` = 'biz.shop.latitude' LIMIT 1) + 0,
	(SELECT `value` FROM `sys_config` WHERE `config_key` = 'biz.shop.longitude' LIMIT 1) + 0,
	NULLIF((SELECT `value` FROM `sys_config` WHERE `config_key` = 'biz.shop.notice' LIMIT 1), ''),
	0,
	true,
	'由单店配置迁移而来（阶段 0：让门店成为实体，展示口径不变）'
FROM (SELECT 1) AS `seed`
WHERE NOT EXISTS (SELECT 1 FROM (SELECT `id` FROM `sys_store` LIMIT 1) AS `existing`);