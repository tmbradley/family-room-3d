-- Mood pieces: template groups (Add furniture menu sections), mount type and typical price per
-- template, per-wall color and finish (accent walls, limewash), and fixtures owned by a design
-- for the Current rooms it links (so a design can hold its own lights and fans).

-- CreateTable
CREATE TABLE `template_groups` (
    `key` VARCHAR(40) NOT NULL,
    `label` VARCHAR(80) NOT NULL,
    `sort` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- The existing 14 templates are furniture; the server syncs the rest at startup.
INSERT INTO `template_groups` (`key`, `label`, `sort`) VALUES
  ('furniture', 'Furniture', 0), ('lighting', 'Lighting', 1), ('wall_decor', 'Wall decor', 2), ('soft_goods', 'Soft goods and plants', 3);

-- AlterTable
ALTER TABLE `furniture_templates` ADD COLUMN `description` VARCHAR(300) NULL,
    ADD COLUMN `group_key` VARCHAR(40) NOT NULL DEFAULT 'furniture',
    ADD COLUMN `mount` VARCHAR(20) NOT NULL DEFAULT 'floor',
    ADD COLUMN `price_high_cents` INTEGER NULL,
    ADD COLUMN `price_low_cents` INTEGER NULL,
    ADD COLUMN `sort` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `fixtures` ADD COLUMN `workspace_id` INTEGER NULL;

-- CreateTable
CREATE TABLE `wall_styles` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `workspace_id` INTEGER NULL,
    `wall_id` INTEGER NOT NULL,
    `color_name` VARCHAR(60) NULL,
    `color` VARCHAR(9) NULL,
    `finish` VARCHAR(20) NOT NULL DEFAULT 'paint',
    `notes` VARCHAR(500) NULL,

    INDEX `wall_styles_wall_id_idx`(`wall_id`),
    UNIQUE INDEX `wall_styles_workspace_id_wall_id_key`(`workspace_id`, `wall_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `fixtures_workspace_id_idx` ON `fixtures`(`workspace_id`);

-- AddForeignKey
ALTER TABLE `fixtures` ADD CONSTRAINT `fixtures_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `furniture_templates` ADD CONSTRAINT `furniture_templates_group_key_fkey` FOREIGN KEY (`group_key`) REFERENCES `template_groups`(`key`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wall_styles` ADD CONSTRAINT `wall_styles_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wall_styles` ADD CONSTRAINT `wall_styles_wall_id_fkey` FOREIGN KEY (`wall_id`) REFERENCES `walls`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- A design now shows its own copy of the fixtures in the Current rooms it links (like furniture).
-- Give existing designs a copy of Current's fixtures so nothing disappears from them.
INSERT INTO `fixtures` (`room_id`, `wall_id`, `type`, `name`, `color`, `x_in`, `y_in`, `count`, `notes`, `measurement_status`, `workspace_id`)
SELECT f.`room_id`, f.`wall_id`, f.`type`, f.`name`, f.`color`, f.`x_in`, f.`y_in`, f.`count`, f.`notes`, f.`measurement_status`, wr.`workspace_id`
FROM `fixtures` f
JOIN `rooms` r ON r.`id` = f.`room_id` AND r.`draft_workspace_id` IS NULL
JOIN `workspace_rooms` wr ON wr.`room_id` = f.`room_id`
WHERE f.`workspace_id` IS NULL;
