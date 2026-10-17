-- P1: proposal statuses pending/approved/rejected (old proposed -> pending, applied -> approved),
-- proposal cost steps, base workspace for "new workspace" proposals, pinned measurements
-- (source = manual, unpinned_at), revision kind "copy", and room slugs unique per workspace.

-- DropForeignKey
ALTER TABLE `rooms` DROP FOREIGN KEY `rooms_house_id_fkey`;

-- DropIndex
DROP INDEX `rooms_house_id_slug_key` ON `rooms`;

-- AlterTable
ALTER TABLE `rooms` MODIFY `measurement_status` ENUM('manual_estimate', 'measured', 'scan', 'manual') NOT NULL DEFAULT 'manual_estimate';

-- AlterTable
ALTER TABLE `walls` MODIFY `measurement_status` ENUM('manual_estimate', 'measured', 'scan', 'manual') NOT NULL DEFAULT 'manual_estimate';

-- AlterTable
ALTER TABLE `openings` MODIFY `measurement_status` ENUM('manual_estimate', 'measured', 'scan', 'manual') NOT NULL DEFAULT 'manual_estimate';

-- AlterTable
ALTER TABLE `fixtures` MODIFY `measurement_status` ENUM('manual_estimate', 'measured', 'scan', 'manual') NOT NULL DEFAULT 'manual_estimate';

-- AlterTable
ALTER TABLE `measurements` ADD COLUMN `unpinned_at` DATETIME(3) NULL,
    MODIFY `source` ENUM('manual_estimate', 'measured', 'scan', 'manual') NOT NULL;

-- AlterTable
ALTER TABLE `furniture_items` MODIFY `measurement_status` ENUM('manual_estimate', 'measured', 'scan', 'manual') NOT NULL DEFAULT 'manual_estimate';

-- AlterTable
ALTER TABLE `placements` MODIFY `measurement_status` ENUM('manual_estimate', 'measured', 'scan', 'manual') NOT NULL DEFAULT 'manual_estimate';

-- AlterTable
ALTER TABLE `proposals` ADD COLUMN `base_workspace_id` INTEGER NULL,
    MODIFY `status` ENUM('proposed', 'approved', 'rejected', 'applied', 'pending') NOT NULL DEFAULT 'pending';
UPDATE `proposals` SET `status` = 'pending' WHERE `status` = 'proposed';
UPDATE `proposals` SET `status` = 'approved' WHERE `status` = 'applied';
ALTER TABLE `proposals` MODIFY `status` ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending';

-- AlterTable
ALTER TABLE `revisions` MODIFY `kind` ENUM('seed', 'save', 'proposal', 'rescan', 'rollback', 'copy') NOT NULL;

-- CreateTable
CREATE TABLE `proposal_cost_steps` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `proposal_id` INTEGER NOT NULL,
    `sort` INTEGER NOT NULL,
    `step` ENUM('paint', 'outlets', 'lighting', 'window', 'furniture', 'rug', 'decor', 'other') NOT NULL,
    `changes_text` VARCHAR(1000) NOT NULL,
    `low_cents` INTEGER NOT NULL,
    `high_cents` INTEGER NOT NULL,

    INDEX `proposal_cost_steps_proposal_id_sort_idx`(`proposal_id`, `sort`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `rooms_house_id_draft_workspace_id_slug_key` ON `rooms`(`house_id`, `draft_workspace_id`, `slug`);

-- AddForeignKey
ALTER TABLE `rooms` ADD CONSTRAINT `rooms_house_id_fkey` FOREIGN KEY (`house_id`) REFERENCES `houses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `proposals` ADD CONSTRAINT `proposals_base_workspace_id_fkey` FOREIGN KEY (`base_workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `proposal_cost_steps` ADD CONSTRAINT `proposal_cost_steps_proposal_id_fkey` FOREIGN KEY (`proposal_id`) REFERENCES `proposals`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

