-- 0005: photos linked to scans/rooms, parametric furniture templates, 3D models, room colors per
-- workspace, measurement proposals, model-capture pairing codes.
-- Additive except one enum widening: uploads.kind gains 'model' (existing values unchanged).

-- AlterTable
ALTER TABLE `placements` ADD COLUMN `model_id` INTEGER NULL,
    ADD COLUMN `template_id` INTEGER NULL;

-- AlterTable
ALTER TABLE `proposals` ADD COLUMN `kind` ENUM('changes', 'measurements') NOT NULL DEFAULT 'changes';

-- AlterTable
ALTER TABLE `upload_tokens` ADD COLUMN `placement_id` INTEGER NULL,
    ADD COLUMN `purpose` ENUM('scan', 'model') NOT NULL DEFAULT 'scan',
    ADD COLUMN `suggestion_count` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `uploads` MODIFY `kind` ENUM('scan', 'photo', 'reference', 'model') NOT NULL;

-- CreateTable
CREATE TABLE `scan_photos` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `upload_id` INTEGER NOT NULL,
    `scan_import_id` INTEGER NULL,
    `room_id` INTEGER NULL,
    `prompt` VARCHAR(120) NULL,
    `note` VARCHAR(1000) NULL,
    `room_tag` VARCHAR(60) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `scan_photos_upload_id_key`(`upload_id`),
    INDEX `scan_photos_scan_import_id_idx`(`scan_import_id`),
    INDEX `scan_photos_room_id_idx`(`room_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `photo_tags` (
    `photo_id` INTEGER NOT NULL,
    `tag` VARCHAR(40) NOT NULL,

    PRIMARY KEY (`photo_id`, `tag`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `furniture_templates` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `slug` VARCHAR(40) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `kind` VARCHAR(40) NOT NULL,
    `default_w_in` INTEGER NOT NULL,
    `default_d_in` INTEGER NOT NULL,
    `default_h_in` INTEGER NOT NULL,

    UNIQUE INDEX `furniture_templates_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `template_categories` (
    `template_id` INTEGER NOT NULL,
    `category` VARCHAR(40) NOT NULL,

    PRIMARY KEY (`template_id`, `category`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `template_params` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `template_id` INTEGER NOT NULL,
    `key` VARCHAR(40) NOT NULL,
    `label` VARCHAR(80) NOT NULL,
    `type` ENUM('number', 'choice', 'color', 'boolean') NOT NULL,
    `default_value` VARCHAR(120) NOT NULL,
    `min_value` INTEGER NULL,
    `max_value` INTEGER NULL,
    `sort` INTEGER NOT NULL DEFAULT 0,

    UNIQUE INDEX `template_params_template_id_key_key`(`template_id`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `template_param_options` (
    `param_id` INTEGER NOT NULL,
    `value` VARCHAR(60) NOT NULL,
    `label` VARCHAR(80) NOT NULL,
    `sort` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`param_id`, `value`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `placement_params` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `placement_id` INTEGER NOT NULL,
    `key` VARCHAR(40) NOT NULL,
    `value` VARCHAR(120) NOT NULL,

    UNIQUE INDEX `placement_params_placement_id_key_key`(`placement_id`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `furniture_models` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `house_id` INTEGER NOT NULL,
    `upload_id` INTEGER NOT NULL,
    `label` VARCHAR(160) NOT NULL,
    `source` ENUM('object_capture', 'upload') NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `furniture_models_upload_id_key`(`upload_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `room_styles` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `workspace_id` INTEGER NOT NULL,
    `room_id` INTEGER NOT NULL,
    `wall_color_name` VARCHAR(60) NULL,
    `wall_color` VARCHAR(9) NULL,
    `trim_color_name` VARCHAR(60) NULL,
    `trim_color` VARCHAR(9) NULL,
    `floor_color_name` VARCHAR(60) NULL,
    `floor_color` VARCHAR(9) NULL,
    `device_color_name` VARCHAR(60) NULL,
    `device_color` VARCHAR(9) NULL,

    UNIQUE INDEX `room_styles_workspace_id_room_id_key`(`workspace_id`, `room_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `proposal_measurements` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `proposal_id` INTEGER NOT NULL,
    `seq` INTEGER NOT NULL,
    `entity_type` VARCHAR(40) NOT NULL,
    `entity_id` INTEGER NOT NULL,
    `field` VARCHAR(60) NOT NULL,
    `value_in` INTEGER NOT NULL,
    `before_in` INTEGER NULL,
    `note` VARCHAR(500) NULL,

    INDEX `proposal_measurements_proposal_id_idx`(`proposal_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `proposal_photos` (
    `proposal_id` INTEGER NOT NULL,
    `photo_id` INTEGER NOT NULL,

    PRIMARY KEY (`proposal_id`, `photo_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `placements` ADD CONSTRAINT `placements_template_id_fkey` FOREIGN KEY (`template_id`) REFERENCES `furniture_templates`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `placements` ADD CONSTRAINT `placements_model_id_fkey` FOREIGN KEY (`model_id`) REFERENCES `furniture_models`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `upload_tokens` ADD CONSTRAINT `upload_tokens_placement_id_fkey` FOREIGN KEY (`placement_id`) REFERENCES `placements`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `scan_photos` ADD CONSTRAINT `scan_photos_upload_id_fkey` FOREIGN KEY (`upload_id`) REFERENCES `uploads`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `scan_photos` ADD CONSTRAINT `scan_photos_scan_import_id_fkey` FOREIGN KEY (`scan_import_id`) REFERENCES `scan_imports`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `scan_photos` ADD CONSTRAINT `scan_photos_room_id_fkey` FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `photo_tags` ADD CONSTRAINT `photo_tags_photo_id_fkey` FOREIGN KEY (`photo_id`) REFERENCES `scan_photos`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `template_categories` ADD CONSTRAINT `template_categories_template_id_fkey` FOREIGN KEY (`template_id`) REFERENCES `furniture_templates`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `template_params` ADD CONSTRAINT `template_params_template_id_fkey` FOREIGN KEY (`template_id`) REFERENCES `furniture_templates`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `template_param_options` ADD CONSTRAINT `template_param_options_param_id_fkey` FOREIGN KEY (`param_id`) REFERENCES `template_params`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `placement_params` ADD CONSTRAINT `placement_params_placement_id_fkey` FOREIGN KEY (`placement_id`) REFERENCES `placements`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `furniture_models` ADD CONSTRAINT `furniture_models_house_id_fkey` FOREIGN KEY (`house_id`) REFERENCES `houses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `furniture_models` ADD CONSTRAINT `furniture_models_upload_id_fkey` FOREIGN KEY (`upload_id`) REFERENCES `uploads`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `room_styles` ADD CONSTRAINT `room_styles_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `room_styles` ADD CONSTRAINT `room_styles_room_id_fkey` FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `proposal_measurements` ADD CONSTRAINT `proposal_measurements_proposal_id_fkey` FOREIGN KEY (`proposal_id`) REFERENCES `proposals`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `proposal_photos` ADD CONSTRAINT `proposal_photos_proposal_id_fkey` FOREIGN KEY (`proposal_id`) REFERENCES `proposals`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `proposal_photos` ADD CONSTRAINT `proposal_photos_photo_id_fkey` FOREIGN KEY (`photo_id`) REFERENCES `scan_photos`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;


-- Scan plan frame. Scans parsed before this release mapped world Z to plan y, which draws a
-- mirror image of the room. New scans use plan y = -world Z. Mark old scans and the rooms built
-- from them so the editor can offer the (Michael-only, rollback-able) mirror fix.
ALTER TABLE `scan_imports` ADD COLUMN `plan_frame` INTEGER NOT NULL DEFAULT 1;
ALTER TABLE `rooms` ADD COLUMN `plan_frame` INTEGER NULL;
UPDATE `rooms` r SET r.`plan_frame` = 1
WHERE r.`draft_workspace_id` IS NULL AND EXISTS (SELECT 1 FROM `scan_imports` si WHERE si.`room_id` = r.`id` AND si.`status` = 'promoted');

-- Backfill: photos uploaded before this migration become scan_photos rows, linked to the scan
-- import made with the same pairing code (and that scan's room).
INSERT INTO `scan_photos` (`upload_id`, `scan_import_id`, `room_id`, `created_at`)
SELECT p.`id`, si.`id`, COALESCE(si.`room_id`, p.`room_id`), p.`created_at`
FROM `uploads` p
LEFT JOIN `uploads` s ON s.`token_id` = p.`token_id` AND s.`kind` = 'scan' AND s.`format` = 'roomplan_json' AND s.`scan_import_id` IS NOT NULL
LEFT JOIN `scan_imports` si ON si.`id` = s.`scan_import_id`
WHERE p.`kind` = 'photo' AND p.`status` IN ('uploaded', 'imported')
  AND NOT EXISTS (SELECT 1 FROM `scan_photos` x WHERE x.`upload_id` = p.`id`);
