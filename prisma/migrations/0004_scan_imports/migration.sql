-- Add scan_imports table for reviewable scans before they become Current
CREATE TABLE `scan_imports` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `house_id` INT NOT NULL,
  `room_id` INT NULL,
  `upload_id` INT NOT NULL,
  `status` ENUM('pending', 'promoted', 'rejected') NOT NULL DEFAULT 'pending',
  `label` VARCHAR(120) NULL,
  `notes` TEXT NULL,
  `promoted_at` DATETIME NULL,
  `promoted_by` ENUM('michael', 'agent', 'system') NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `scan_imports_house_id_idx` (`house_id`),
  INDEX `scan_imports_upload_id_idx` (`upload_id`),
  INDEX `scan_imports_status_idx` (`status`),
  FOREIGN KEY (`house_id`) REFERENCES `houses` (`id`) ON DELETE CASCADE,
  FOREIGN KEY (`room_id`) REFERENCES `rooms` (`id`) ON DELETE SET NULL,
  FOREIGN KEY (`upload_id`) REFERENCES `uploads` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Add scan_import_data table to store parsed RoomPlan data before promotion
CREATE TABLE `scan_import_data` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `scan_import_id` INT NOT NULL,
  `entity_type` VARCHAR(40) NOT NULL,
  `entity_index` INT NOT NULL,
  `field` VARCHAR(60) NOT NULL,
  `value` VARCHAR(1000) NOT NULL,
  INDEX `scan_import_data_scan_import_id_idx` (`scan_import_id`),
  FOREIGN KEY (`scan_import_id`) REFERENCES `scan_imports` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Update uploads table to track which scan_import it belongs to (optional)
ALTER TABLE `uploads` ADD COLUMN `scan_import_id` INT NULL AFTER `uploaded_by`;
ALTER TABLE `uploads` ADD INDEX `uploads_scan_import_id_idx` (`scan_import_id`);
