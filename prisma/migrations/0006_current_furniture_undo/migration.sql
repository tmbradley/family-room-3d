-- 0006: Current holds furniture and colors (changed only by approved proposals, scans and
-- measurements), and the editor can undo. Additive only; no existing row changes.

-- A measurement undone in the editor stays on record but no longer counts.
ALTER TABLE `measurements` ADD COLUMN `withdrawn_at` DATETIME(3) NULL;

-- Proposals can target Current (furniture placements and room colors only).
ALTER TABLE `proposals` ADD COLUMN `target_current` BOOLEAN NOT NULL DEFAULT false;

-- Room colors with workspace_id NULL are Current's (one row per room, enforced by the server).
ALTER TABLE `room_styles` MODIFY `workspace_id` INTEGER NULL;
