-- Designs can be archived (hidden, read-only, restorable) and remember the scan they were started from.
ALTER TABLE `workspaces` ADD COLUMN `archived_at` DATETIME(3) NULL,
    ADD COLUMN `source_scan_id` INTEGER NULL;

ALTER TABLE `workspaces` ADD CONSTRAINT `workspaces_source_scan_id_fkey` FOREIGN KEY (`source_scan_id`) REFERENCES `scan_imports`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: designs made by "Furnish from scan" before this column existed. Their first save revision
-- has the note "Furniture from scan #<id>: ..." (fills only the new column; nothing else changes).
UPDATE `workspaces` w
  JOIN (
    SELECT `workspace_id`, MIN(CAST(SUBSTRING_INDEX(SUBSTRING(`note`, 22), ':', 1) AS UNSIGNED)) AS sid
    FROM `revisions`
    WHERE `workspace_id` IS NOT NULL AND `note` LIKE 'Furniture from scan #%'
    GROUP BY `workspace_id`
  ) r ON r.`workspace_id` = w.`id`
  JOIN `scan_imports` s ON s.`id` = r.sid
  SET w.`source_scan_id` = r.sid
  WHERE w.`source_scan_id` IS NULL;
