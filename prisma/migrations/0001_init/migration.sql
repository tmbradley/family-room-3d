-- CreateTable
CREATE TABLE `houses` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(120) NOT NULL,
    `current_revision` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rooms` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `house_id` INTEGER NOT NULL,
    `slug` VARCHAR(60) NOT NULL,
    `label` VARCHAR(120) NOT NULL,
    `origin_x_in` INTEGER NOT NULL DEFAULT 0,
    `origin_y_in` INTEGER NOT NULL DEFAULT 0,
    `rotation_deg` INTEGER NOT NULL DEFAULT 0,
    `ceiling_in` INTEGER NOT NULL,
    `floor_material` VARCHAR(80) NULL,
    `floor_finish` VARCHAR(80) NULL,
    `floor_color` VARCHAR(9) NULL,
    `floor_keep` BOOLEAN NOT NULL DEFAULT false,
    `wall_color_name` VARCHAR(60) NULL,
    `wall_color` VARCHAR(9) NULL,
    `trim_color_name` VARCHAR(60) NULL,
    `trim_color` VARCHAR(9) NULL,
    `measurement_status` ENUM('manual_estimate', 'measured', 'scan') NOT NULL DEFAULT 'manual_estimate',

    UNIQUE INDEX `rooms_house_id_slug_key`(`house_id`, `slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `walls` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `room_id` INTEGER NOT NULL,
    `label` VARCHAR(60) NULL,
    `start_x_in` INTEGER NOT NULL,
    `start_y_in` INTEGER NOT NULL,
    `end_x_in` INTEGER NOT NULL,
    `end_y_in` INTEGER NOT NULL,
    `height_in` INTEGER NOT NULL,
    `thickness_in` INTEGER NOT NULL DEFAULT 5,
    `is_open` BOOLEAN NOT NULL DEFAULT false,
    `open_to` VARCHAR(80) NULL,
    `notes` VARCHAR(500) NULL,
    `measurement_status` ENUM('manual_estimate', 'measured', 'scan') NOT NULL DEFAULT 'manual_estimate',

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `openings` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `wall_id` INTEGER NOT NULL,
    `label` VARCHAR(60) NULL,
    `type` ENUM('window', 'door', 'open_span', 'fireplace') NOT NULL,
    `offset_in` INTEGER NOT NULL,
    `width_in` INTEGER NOT NULL,
    `sill_in` INTEGER NULL,
    `head_in` INTEGER NULL,
    `flush` BOOLEAN NOT NULL DEFAULT false,
    `treatment` VARCHAR(120) NULL,
    `notes` VARCHAR(500) NULL,
    `measurement_status` ENUM('manual_estimate', 'measured', 'scan') NOT NULL DEFAULT 'manual_estimate',

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `fixtures` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `room_id` INTEGER NOT NULL,
    `wall_id` INTEGER NULL,
    `type` ENUM('ceiling_fan', 'light', 'outlet', 'switch', 'window_treatment', 'other') NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `color` VARCHAR(9) NULL,
    `x_in` INTEGER NULL,
    `y_in` INTEGER NULL,
    `count` INTEGER NOT NULL DEFAULT 1,
    `notes` VARCHAR(500) NULL,
    `measurement_status` ENUM('manual_estimate', 'measured', 'scan') NOT NULL DEFAULT 'manual_estimate',

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `room_links` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `wall_a_id` INTEGER NOT NULL,
    `wall_b_id` INTEGER NOT NULL,
    `offset_in` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `measurements` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `entity_type` VARCHAR(40) NOT NULL,
    `entity_id` INTEGER NOT NULL,
    `field` VARCHAR(60) NOT NULL,
    `value_in` INTEGER NOT NULL,
    `source` ENUM('manual_estimate', 'measured', 'scan') NOT NULL,
    `is_override` BOOLEAN NOT NULL DEFAULT false,
    `upload_id` INTEGER NULL,
    `recorded_by` ENUM('michael', 'agent', 'system') NOT NULL,
    `recorded_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `note` VARCHAR(500) NULL,

    INDEX `measurements_entity_type_entity_id_field_idx`(`entity_type`, `entity_id`, `field`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `workspaces` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `house_id` INTEGER NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `notes` TEXT NULL,
    `base_revision` INTEGER NOT NULL DEFAULT 0,
    `revision` INTEGER NOT NULL DEFAULT 0,
    `created_by` ENUM('michael', 'agent', 'system') NOT NULL,
    `source_proposal_id` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `workspaces_source_proposal_id_key`(`source_proposal_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `workspace_rooms` (
    `workspace_id` INTEGER NOT NULL,
    `room_id` INTEGER NOT NULL,

    PRIMARY KEY (`workspace_id`, `room_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `workspace_room_styles` (
    `workspace_id` INTEGER NOT NULL,
    `room_id` INTEGER NOT NULL,
    `wall_color` VARCHAR(9) NULL,
    `trim_color` VARCHAR(9) NULL,
    `floor_color` VARCHAR(9) NULL,

    PRIMARY KEY (`workspace_id`, `room_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `structure_overrides` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `workspace_id` INTEGER NOT NULL,
    `entity_type` VARCHAR(40) NOT NULL,
    `entity_id` INTEGER NULL,
    `field` VARCHAR(60) NOT NULL,
    `value` VARCHAR(1000) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stores` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(120) NOT NULL,
    `url` VARCHAR(500) NULL,
    `notes` VARCHAR(1000) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `furniture_items` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `slug` VARCHAR(80) NULL,
    `kind` VARCHAR(40) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `w_in` INTEGER NOT NULL,
    `d_in` INTEGER NOT NULL,
    `h_in` INTEGER NOT NULL,
    `color` VARCHAR(9) NULL,
    `accent_color` VARCHAR(9) NULL,
    `store_id` INTEGER NULL,
    `url` VARCHAR(1000) NULL,
    `price_cents` INTEGER NULL,
    `image_url` VARCHAR(1000) NULL,
    `status` ENUM('idea', 'shortlisted', 'bought', 'existing') NOT NULL DEFAULT 'idea',
    `notes` VARCHAR(1000) NULL,
    `measurement_status` ENUM('manual_estimate', 'measured', 'scan') NOT NULL DEFAULT 'manual_estimate',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `furniture_items_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `placements` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `workspace_id` INTEGER NULL,
    `room_id` INTEGER NOT NULL,
    `item_id` INTEGER NOT NULL,
    `x_in` INTEGER NOT NULL,
    `y_in` INTEGER NOT NULL,
    `rotation_deg` INTEGER NOT NULL DEFAULT 0,
    `action` ENUM('existing', 'keep', 'replace', 'remove', 'new') NOT NULL,
    `replaces_placement_id` INTEGER NULL,
    `notes` VARCHAR(500) NULL,
    `measurement_status` ENUM('manual_estimate', 'measured', 'scan') NOT NULL DEFAULT 'manual_estimate',

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `proposals` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `house_id` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_by` ENUM('michael', 'agent', 'system') NOT NULL,
    `agent_key_id` INTEGER NULL,
    `source_kind` ENUM('x_bookmark', 'bot', 'manual') NOT NULL,
    `source_url` VARCHAR(1000) NULL,
    `source_image_url` VARCHAR(1000) NULL,
    `inspiration_id` INTEGER NULL,
    `target_workspace_id` INTEGER NULL,
    `new_workspace_name` VARCHAR(120) NULL,
    `title` VARCHAR(200) NOT NULL,
    `rationale` TEXT NULL,
    `cost_low_cents` INTEGER NULL,
    `cost_high_cents` INTEGER NULL,
    `status` ENUM('proposed', 'approved', 'rejected', 'applied') NOT NULL DEFAULT 'proposed',
    `decided_at` DATETIME(3) NULL,
    `decision_note` VARCHAR(1000) NULL,
    `base_revision` INTEGER NOT NULL DEFAULT 0,

    INDEX `proposals_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `proposal_rooms` (
    `proposal_id` INTEGER NOT NULL,
    `room_id` INTEGER NOT NULL,

    PRIMARY KEY (`proposal_id`, `room_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `proposal_changes` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `proposal_id` INTEGER NOT NULL,
    `seq` INTEGER NOT NULL,
    `op` ENUM('create', 'update', 'delete') NOT NULL,
    `entity_type` VARCHAR(40) NOT NULL,
    `entity_id` INTEGER NULL,
    `temp_ref` VARCHAR(40) NULL,
    `field` VARCHAR(60) NULL,
    `before_value` VARCHAR(1000) NULL,
    `after_value` VARCHAR(1000) NULL,

    INDEX `proposal_changes_proposal_id_seq_idx`(`proposal_id`, `seq`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `proposal_comments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `proposal_id` INTEGER NOT NULL,
    `author` ENUM('michael', 'agent', 'system') NOT NULL,
    `agent_key_id` INTEGER NULL,
    `body` TEXT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `revisions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `house_id` INTEGER NOT NULL,
    `workspace_id` INTEGER NULL,
    `scope` VARCHAR(40) NOT NULL,
    `number` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `actor` ENUM('michael', 'agent', 'system') NOT NULL,
    `agent_key_id` INTEGER NULL,
    `kind` ENUM('seed', 'save', 'proposal', 'rescan', 'rollback') NOT NULL,
    `proposal_id` INTEGER NULL,
    `rolls_back_revision_id` INTEGER NULL,
    `note` VARCHAR(1000) NULL,

    UNIQUE INDEX `revisions_house_id_scope_number_key`(`house_id`, `scope`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `revision_changes` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `revision_id` INTEGER NOT NULL,
    `seq` INTEGER NOT NULL,
    `op` ENUM('create', 'update', 'delete') NOT NULL,
    `entity_type` VARCHAR(40) NOT NULL,
    `entity_id` INTEGER NOT NULL,
    `field` VARCHAR(60) NULL,
    `before_value` VARCHAR(1000) NULL,
    `after_value` VARCHAR(1000) NULL,

    INDEX `revision_changes_revision_id_seq_idx`(`revision_id`, `seq`),
    INDEX `revision_changes_entity_type_entity_id_field_idx`(`entity_type`, `entity_id`, `field`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cost_estimates` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `workspace_id` INTEGER NOT NULL,
    `total_low_cents` INTEGER NOT NULL,
    `total_high_cents` INTEGER NOT NULL,
    `revision` INTEGER NOT NULL,
    `computed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cost_steps` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `estimate_id` INTEGER NOT NULL,
    `step` ENUM('paint', 'outlets', 'lighting', 'window', 'furniture', 'rug', 'decor', 'other') NOT NULL,
    `sort` INTEGER NOT NULL,
    `changes_text` VARCHAR(1000) NOT NULL,
    `low_cents` INTEGER NOT NULL,
    `high_cents` INTEGER NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cost_step_items` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `step_id` INTEGER NOT NULL,
    `placement_id` INTEGER NULL,
    `item_id` INTEGER NULL,
    `label` VARCHAR(200) NOT NULL,
    `low_cents` INTEGER NOT NULL,
    `high_cents` INTEGER NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `uploads` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `house_id` INTEGER NOT NULL,
    `room_id` INTEGER NULL,
    `kind` ENUM('scan', 'photo', 'reference') NOT NULL,
    `format` ENUM('usdz', 'glb', 'roomplan_json', 'jpg', 'heic', 'png') NOT NULL,
    `bucket_key` VARCHAR(500) NOT NULL,
    `bytes` INTEGER NULL,
    `status` ENUM('pending', 'uploaded', 'imported', 'rejected') NOT NULL DEFAULT 'pending',
    `uploaded_by` ENUM('michael', 'agent', 'system') NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uploads_bucket_key_key`(`bucket_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inspiration` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `x_post_id` VARCHAR(40) NULL,
    `url` VARCHAR(1000) NOT NULL,
    `author_handle` VARCHAR(80) NULL,
    `post_text` TEXT NULL,
    `bookmarked_at` DATETIME(3) NULL,
    `classified_at` DATETIME(3) NULL,
    `is_design` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `inspiration_x_post_id_key`(`x_post_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inspiration_media` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `inspiration_id` INTEGER NOT NULL,
    `url` VARCHAR(1000) NOT NULL,
    `type` VARCHAR(20) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inspiration_rooms` (
    `inspiration_id` INTEGER NOT NULL,
    `room_id` INTEGER NOT NULL,

    PRIMARY KEY (`inspiration_id`, `room_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `exports` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `bucket_key` VARCHAR(500) NULL,
    `bytes` INTEGER NULL,
    `status` VARCHAR(20) NOT NULL,
    `error` VARCHAR(1000) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `users` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(120) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `passkeys` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `user_id` INTEGER NOT NULL,
    `credential_id` VARCHAR(255) NOT NULL,
    `public_key` BLOB NOT NULL,
    `counter` INTEGER NOT NULL DEFAULT 0,
    `transports` VARCHAR(200) NULL,
    `device_name` VARCHAR(120) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_used_at` DATETIME(3) NULL,

    UNIQUE INDEX `passkeys_credential_id_key`(`credential_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sessions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `user_id` INTEGER NOT NULL,
    `token_hash` CHAR(64) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expires_at` DATETIME(3) NOT NULL,
    `last_seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `sessions_token_hash_key`(`token_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `setup_codes` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `code_hash` CHAR(64) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expires_at` DATETIME(3) NOT NULL,
    `used_at` DATETIME(3) NULL,

    UNIQUE INDEX `setup_codes_code_hash_key`(`code_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `recovery_codes` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `user_id` INTEGER NOT NULL,
    `code_hash` CHAR(64) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `used_at` DATETIME(3) NULL,

    UNIQUE INDEX `recovery_codes_code_hash_key`(`code_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `auth_challenges` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `token_hash` CHAR(64) NOT NULL,
    `kind` ENUM('register', 'login') NOT NULL,
    `challenge` VARCHAR(255) NOT NULL,
    `setup_code_id` INTEGER NULL,
    `user_id` INTEGER NULL,
    `expires_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `auth_challenges_token_hash_key`(`token_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `agent_keys` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(120) NOT NULL,
    `prefix` VARCHAR(20) NOT NULL,
    `key_hash` CHAR(64) NOT NULL,
    `scope` ENUM('read', 'propose', 'admin') NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_used_at` DATETIME(3) NULL,
    `revoked_at` DATETIME(3) NULL,

    UNIQUE INDEX `agent_keys_key_hash_key`(`key_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `upload_tokens` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `token_hash` CHAR(64) NOT NULL,
    `room_id` INTEGER NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `used_at` DATETIME(3) NULL,

    UNIQUE INDEX `upload_tokens_token_hash_key`(`token_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `rooms` ADD CONSTRAINT `rooms_house_id_fkey` FOREIGN KEY (`house_id`) REFERENCES `houses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `walls` ADD CONSTRAINT `walls_room_id_fkey` FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `openings` ADD CONSTRAINT `openings_wall_id_fkey` FOREIGN KEY (`wall_id`) REFERENCES `walls`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `fixtures` ADD CONSTRAINT `fixtures_room_id_fkey` FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `fixtures` ADD CONSTRAINT `fixtures_wall_id_fkey` FOREIGN KEY (`wall_id`) REFERENCES `walls`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `room_links` ADD CONSTRAINT `room_links_wall_a_id_fkey` FOREIGN KEY (`wall_a_id`) REFERENCES `walls`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `room_links` ADD CONSTRAINT `room_links_wall_b_id_fkey` FOREIGN KEY (`wall_b_id`) REFERENCES `walls`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `measurements` ADD CONSTRAINT `measurements_upload_id_fkey` FOREIGN KEY (`upload_id`) REFERENCES `uploads`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `workspaces` ADD CONSTRAINT `workspaces_house_id_fkey` FOREIGN KEY (`house_id`) REFERENCES `houses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `workspaces` ADD CONSTRAINT `workspaces_source_proposal_id_fkey` FOREIGN KEY (`source_proposal_id`) REFERENCES `proposals`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `workspace_rooms` ADD CONSTRAINT `workspace_rooms_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `workspace_rooms` ADD CONSTRAINT `workspace_rooms_room_id_fkey` FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `workspace_room_styles` ADD CONSTRAINT `workspace_room_styles_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `workspace_room_styles` ADD CONSTRAINT `workspace_room_styles_room_id_fkey` FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `structure_overrides` ADD CONSTRAINT `structure_overrides_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `furniture_items` ADD CONSTRAINT `furniture_items_store_id_fkey` FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `placements` ADD CONSTRAINT `placements_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `placements` ADD CONSTRAINT `placements_room_id_fkey` FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `placements` ADD CONSTRAINT `placements_item_id_fkey` FOREIGN KEY (`item_id`) REFERENCES `furniture_items`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `placements` ADD CONSTRAINT `placements_replaces_placement_id_fkey` FOREIGN KEY (`replaces_placement_id`) REFERENCES `placements`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `proposals` ADD CONSTRAINT `proposals_house_id_fkey` FOREIGN KEY (`house_id`) REFERENCES `houses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `proposals` ADD CONSTRAINT `proposals_agent_key_id_fkey` FOREIGN KEY (`agent_key_id`) REFERENCES `agent_keys`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `proposals` ADD CONSTRAINT `proposals_inspiration_id_fkey` FOREIGN KEY (`inspiration_id`) REFERENCES `inspiration`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `proposals` ADD CONSTRAINT `proposals_target_workspace_id_fkey` FOREIGN KEY (`target_workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `proposal_rooms` ADD CONSTRAINT `proposal_rooms_proposal_id_fkey` FOREIGN KEY (`proposal_id`) REFERENCES `proposals`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `proposal_rooms` ADD CONSTRAINT `proposal_rooms_room_id_fkey` FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `proposal_changes` ADD CONSTRAINT `proposal_changes_proposal_id_fkey` FOREIGN KEY (`proposal_id`) REFERENCES `proposals`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `proposal_comments` ADD CONSTRAINT `proposal_comments_proposal_id_fkey` FOREIGN KEY (`proposal_id`) REFERENCES `proposals`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `proposal_comments` ADD CONSTRAINT `proposal_comments_agent_key_id_fkey` FOREIGN KEY (`agent_key_id`) REFERENCES `agent_keys`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `revisions` ADD CONSTRAINT `revisions_house_id_fkey` FOREIGN KEY (`house_id`) REFERENCES `houses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `revisions` ADD CONSTRAINT `revisions_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `revisions` ADD CONSTRAINT `revisions_agent_key_id_fkey` FOREIGN KEY (`agent_key_id`) REFERENCES `agent_keys`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `revisions` ADD CONSTRAINT `revisions_proposal_id_fkey` FOREIGN KEY (`proposal_id`) REFERENCES `proposals`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `revisions` ADD CONSTRAINT `revisions_rolls_back_revision_id_fkey` FOREIGN KEY (`rolls_back_revision_id`) REFERENCES `revisions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `revision_changes` ADD CONSTRAINT `revision_changes_revision_id_fkey` FOREIGN KEY (`revision_id`) REFERENCES `revisions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cost_estimates` ADD CONSTRAINT `cost_estimates_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cost_steps` ADD CONSTRAINT `cost_steps_estimate_id_fkey` FOREIGN KEY (`estimate_id`) REFERENCES `cost_estimates`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cost_step_items` ADD CONSTRAINT `cost_step_items_step_id_fkey` FOREIGN KEY (`step_id`) REFERENCES `cost_steps`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cost_step_items` ADD CONSTRAINT `cost_step_items_placement_id_fkey` FOREIGN KEY (`placement_id`) REFERENCES `placements`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cost_step_items` ADD CONSTRAINT `cost_step_items_item_id_fkey` FOREIGN KEY (`item_id`) REFERENCES `furniture_items`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `uploads` ADD CONSTRAINT `uploads_house_id_fkey` FOREIGN KEY (`house_id`) REFERENCES `houses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `uploads` ADD CONSTRAINT `uploads_room_id_fkey` FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inspiration_media` ADD CONSTRAINT `inspiration_media_inspiration_id_fkey` FOREIGN KEY (`inspiration_id`) REFERENCES `inspiration`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inspiration_rooms` ADD CONSTRAINT `inspiration_rooms_inspiration_id_fkey` FOREIGN KEY (`inspiration_id`) REFERENCES `inspiration`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inspiration_rooms` ADD CONSTRAINT `inspiration_rooms_room_id_fkey` FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `passkeys` ADD CONSTRAINT `passkeys_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `recovery_codes` ADD CONSTRAINT `recovery_codes_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `upload_tokens` ADD CONSTRAINT `upload_tokens_room_id_fkey` FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

