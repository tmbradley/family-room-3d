-- The seeded family room was a test room, not the house's Current.
-- Current becomes optional (houses.current_revision NULL = no Current yet), and rooms can be
-- draft rooms owned by one workspace (rooms.draft_workspace_id) instead of part of Current.

-- AlterTable
ALTER TABLE `houses` MODIFY `current_revision` INTEGER NULL;

-- AlterTable
ALTER TABLE `rooms` ADD COLUMN `draft_workspace_id` INTEGER NULL;

-- AlterTable
ALTER TABLE `workspaces` MODIFY `base_revision` INTEGER NULL;

-- CreateIndex
CREATE INDEX `rooms_draft_workspace_id_idx` ON `rooms`(`draft_workspace_id`);

-- AddForeignKey
ALTER TABLE `rooms` ADD CONSTRAINT `rooms_draft_workspace_id_fkey` FOREIGN KEY (`draft_workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;


-- Data: move every seeded room (and its as-is furniture) out of Current into an ordinary
-- editable workspace "Test room (family room draft)". Measurements are kept unchanged.
INSERT INTO `workspaces` (`house_id`, `name`, `notes`, `base_revision`, `revision`, `created_by`, `created_at`)
SELECT h.`id`, 'Test room (family room draft)',
       'Test room built from rough numbers and photos. Not the house''s Current. Current is created later from a real scan or confirmed measurements.',
       NULL, h.`current_revision`, 'system', CURRENT_TIMESTAMP(3)
FROM `houses` h
WHERE h.`current_revision` IS NOT NULL
  AND EXISTS (SELECT 1 FROM `rooms` r WHERE r.`house_id` = h.`id` AND r.`draft_workspace_id` IS NULL);

UPDATE `rooms` r
JOIN `workspaces` w ON w.`house_id` = r.`house_id` AND w.`name` = 'Test room (family room draft)'
SET r.`draft_workspace_id` = w.`id`
WHERE r.`draft_workspace_id` IS NULL;

INSERT INTO `workspace_rooms` (`workspace_id`, `room_id`)
SELECT r.`draft_workspace_id`, r.`id` FROM `rooms` r
WHERE r.`draft_workspace_id` IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM `workspace_rooms` wr WHERE wr.`workspace_id` = r.`draft_workspace_id` AND wr.`room_id` = r.`id`);

UPDATE `placements` p
JOIN `rooms` r ON r.`id` = p.`room_id`
SET p.`workspace_id` = r.`draft_workspace_id`
WHERE p.`workspace_id` IS NULL AND r.`draft_workspace_id` IS NOT NULL;

UPDATE `revisions` v
JOIN `workspaces` w ON w.`house_id` = v.`house_id` AND w.`name` = 'Test room (family room draft)'
SET v.`scope` = CONCAT('workspace:', w.`id`), v.`workspace_id` = w.`id`,
    v.`note` = CONCAT(COALESCE(v.`note`, ''), ' (re-scoped: test room, not Current)')
WHERE v.`scope` = 'current';

UPDATE `houses` SET `current_revision` = NULL;
