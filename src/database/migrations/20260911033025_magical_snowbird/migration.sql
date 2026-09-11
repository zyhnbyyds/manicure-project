ALTER TABLE `biz_service_item` ADD `images` json;
--> statement-breakpoint
-- 把历史单图升级成图集：原 `image` 直接当首图，否则改版后这些项目的「图片」列会一片空白
-- （`images` 为空才回填，重复执行不会覆盖已经在后台维护过多图的数据）
UPDATE `biz_service_item` SET `images` = JSON_ARRAY(`image`) WHERE `image` IS NOT NULL AND `images` IS NULL;
