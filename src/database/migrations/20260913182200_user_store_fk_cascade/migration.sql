-- 「账号 ↔ 可见门店」两个外键补上 ON DELETE CASCADE。
--
-- ## 为什么是手写迁移
--
-- schema 里写的是 `.onDelete('cascade')`（账号/门店被硬删时关联行自动清理），
-- 但 `20260913180612_puzzling_boom_boom` 生成的建表语句里**两个外键都没带 ON DELETE** ——
-- 而 drizzle 的 snapshot 记的是「已带 cascade」，此后 `db:generate` 只会回一句
-- 「No schema changes」再也不修。也就是说：**工具认为没问题，数据库里却没有**。
-- 这种「工具看不见的漂移」只能显式补一条迁移修掉，否则：
-- - 硬删账号（测试夹具、运维脚本）会报 1451；
-- - 语义上与 schema 声明不一致，下次谁看 schema 都会被误导。
--
-- 先 DROP 再 ADD 是 MySQL 改外键行为的唯一办法（没有 ALTER ... ON DELETE）。
ALTER TABLE `sys_user_store` DROP FOREIGN KEY `fk_user_store_user`;
--> statement-breakpoint
ALTER TABLE `sys_user_store` DROP FOREIGN KEY `fk_user_store_store`;
--> statement-breakpoint
ALTER TABLE `sys_user_store`
  ADD CONSTRAINT `fk_user_store_user` FOREIGN KEY (`user_id`) REFERENCES `sys_user`(`id`) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE `sys_user_store`
  ADD CONSTRAINT `fk_user_store_store` FOREIGN KEY (`store_id`) REFERENCES `sys_store`(`id`) ON DELETE CASCADE;
