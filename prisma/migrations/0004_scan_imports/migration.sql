/*
  Warnings:

  - You are about to alter the column `expires_at` on the `upload_tokens` table. The data in that column could be lost. The data in that column will be cast from `DateTime(3)` to `DateTime(0)`.
  - You are about to alter the column `used_at` on the `upload_tokens` table. The data in that column could be lost. The data in that column will be cast from `DateTime(3)` to `DateTime(0)`.
  - You are about to alter the column `created_at` on the `uploads` table. The data in that column could be lost. The data in that column will be cast from `DateTime(3)` to `DateTime(0)`.

*/
-- AlterTable
ALTER TABLE `upload_tokens` ADD COLUMN `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    ADD COLUMN `new_room` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `upload_count` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `upload_limit` INTEGER NOT NULL DEFAULT 10,
    MODIFY `expires_at` DATETIME(0) NOT NULL,
    MODIFY `used_at` DATETIME(0) NULL;

-- AlterTable
ALTER TABLE `uploads` ADD COLUMN `scan_import_id` INTEGER NULL,
    ADD COLUMN `token_id` INTEGER NULL,
    MODIFY `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0);

-- CreateTable
CREATE TABLE `scan_imports` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `house_id` INTEGER NOT NULL,
    `room_id` INTEGER NULL,
    `upload_id` INTEGER NOT NULL,
    `status` ENUM('pending', 'promoted', 'rejected') NOT NULL DEFAULT 'pending',
    `label` VARCHAR(120) NULL,
    `notes` TEXT NULL,
    `promoted_at` DATETIME(0) NULL,
    `promoted_by` ENUM('michael', 'agent', 'system') NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `scan_imports_upload_id_key`(`upload_id`),
    INDEX `scan_imports_house_id_idx`(`house_id`),
    INDEX `scan_imports_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `scan_import_data` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `scan_import_id` INTEGER NOT NULL,
    `entity_type` VARCHAR(40) NOT NULL,
    `entity_index` INTEGER NOT NULL,
    `field` VARCHAR(60) NOT NULL,
    `value` VARCHAR(1000) NOT NULL,

    INDEX `scan_import_data_scan_import_id_idx`(`scan_import_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `uploads_scan_import_id_idx` ON `uploads`(`scan_import_id`);

-- CreateIndex
CREATE INDEX `uploads_token_id_idx` ON `uploads`(`token_id`);

-- AddForeignKey
ALTER TABLE `uploads` ADD CONSTRAINT `uploads_token_id_fkey` FOREIGN KEY (`token_id`) REFERENCES `upload_tokens`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `uploads` ADD CONSTRAINT `uploads_scan_import_id_fkey` FOREIGN KEY (`scan_import_id`) REFERENCES `scan_imports`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `scan_imports` ADD CONSTRAINT `scan_imports_house_id_fkey` FOREIGN KEY (`house_id`) REFERENCES `houses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `scan_imports` ADD CONSTRAINT `scan_imports_room_id_fkey` FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `scan_imports` ADD CONSTRAINT `scan_imports_upload_id_fkey` FOREIGN KEY (`upload_id`) REFERENCES `uploads`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `scan_import_data` ADD CONSTRAINT `scan_import_data_scan_import_id_fkey` FOREIGN KEY (`scan_import_id`) REFERENCES `scan_imports`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
