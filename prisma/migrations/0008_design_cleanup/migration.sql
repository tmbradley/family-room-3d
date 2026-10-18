-- One-time cleanup of Michael's designs, approved by him on Oct 17, 2026 (EDT).
-- Rename workspace 8 to "Family room · As furnished" (recorded as a normal save revision so it shows in
-- History and can be rolled back), and archive workspaces 1, 9 and 10. Archive only: nothing is deleted.
-- Guarded so it does nothing if those designs were already changed.

INSERT INTO `revisions` (`house_id`, `workspace_id`, `scope`, `number`, `created_at`, `actor`, `kind`, `note`)
SELECT `house_id`, `id`, 'workspace:8', `revision` + 1, NOW(3), 'michael', 'save', 'Renamed to "Family room · As furnished" (cleanup Michael approved)'
FROM `workspaces` WHERE `id` = 8 AND `name` = 'Family room furniture' AND `archived_at` IS NULL;

INSERT INTO `revision_changes` (`revision_id`, `seq`, `op`, `entity_type`, `entity_id`, `field`, `before_value`, `after_value`)
SELECT r.`id`, 0, 'update', 'workspace', 8, 'name', 'Family room furniture', 'Family room · As furnished'
FROM `revisions` r JOIN `workspaces` w ON w.`id` = 8 AND r.`scope` = 'workspace:8' AND r.`house_id` = w.`house_id` AND r.`number` = w.`revision` + 1
WHERE w.`name` = 'Family room furniture' AND w.`archived_at` IS NULL;

UPDATE `workspaces` SET `name` = 'Family room · As furnished', `revision` = `revision` + 1
WHERE `id` = 8 AND `name` = 'Family room furniture' AND `archived_at` IS NULL;

UPDATE `workspaces` SET `archived_at` = NOW(3) WHERE `id` IN (1, 9, 10) AND `archived_at` IS NULL;
