CREATE TABLE `biz_staff_store` (
	`id` int unsigned AUTO_INCREMENT PRIMARY KEY,
	`staff_id` int unsigned NOT NULL,
	`store_id` int unsigned NOT NULL,
	CONSTRAINT `uq_staff_store` UNIQUE INDEX(`staff_id`,`store_id`),
	CONSTRAINT `fk_staff_store_staff` FOREIGN KEY (`staff_id`) REFERENCES `biz_staff`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_staff_store_store` FOREIGN KEY (`store_id`) REFERENCES `sys_store`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_staff_store_store` ON `biz_staff_store` (`store_id`);