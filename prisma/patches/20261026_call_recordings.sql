-- Apply only after 20261026_calls.sql has been applied.
-- This file creates metadata tables only; recording bytes remain in private S3 storage.
CREATE TABLE `call_recording_consents` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `call_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `consented_at` DATETIME(0) NULL,
    `revoked_at` DATETIME(0) NULL,
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    PRIMARY KEY (`id`),
    UNIQUE INDEX `uq_call_recording_consent`(`call_id`, `user_id`),
    INDEX `idx_call_recording_consents_user`(`user_id`, `call_id`),
    CONSTRAINT `fk_call_recording_consents_call` FOREIGN KEY (`call_id`) REFERENCES `call_sessions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `fk_call_recording_consents_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `call_recordings` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `call_id` BIGINT UNSIGNED NOT NULL,
    `egress_id` VARCHAR(128) NULL,
    `object_key` VARCHAR(512) NOT NULL,
    `status` ENUM('starting', 'active', 'stopping', 'stop_failed', 'completed', 'failed', 'deleting', 'delete_failed', 'deleted') NOT NULL DEFAULT 'starting',
    `content_type` VARCHAR(100) NOT NULL DEFAULT 'video/mp4',
    `file_size` BIGINT UNSIGNED NULL,
    `duration_ms` BIGINT UNSIGNED NULL,
    `started_at` DATETIME(0) NULL,
    `completed_at` DATETIME(0) NULL,
    `retention_expires_at` DATETIME(0) NULL,
    `deleted_at` DATETIME(0) NULL,
    `last_egress_event_at` DATETIME(0) NULL,
    `last_error` VARCHAR(500) NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    PRIMARY KEY (`id`),
    UNIQUE INDEX `uq_call_recordings_egress`(`egress_id`),
    UNIQUE INDEX `uq_call_recordings_object_key`(`object_key`),
    INDEX `idx_call_recordings_call_created`(`call_id`, `created_at`),
    INDEX `idx_call_recordings_retention`(`status`, `retention_expires_at`),
    CONSTRAINT `fk_call_recordings_call` FOREIGN KEY (`call_id`) REFERENCES `call_sessions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `livekit_webhook_events` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `webhook_id` CHAR(36) NOT NULL,
    `event_type` VARCHAR(40) NOT NULL,
    `egress_id` VARCHAR(128) NULL,
    `egress_status` INT NULL,
    `event_created_at` DATETIME(0) NOT NULL,
    `egress_started_at` DATETIME(0) NULL,
    `egress_ended_at` DATETIME(0) NULL,
    `file_size` BIGINT UNSIGNED NULL,
    `duration_ms` BIGINT UNSIGNED NULL,
    `error_code` INT NULL,
    `error_message` VARCHAR(500) NULL,
    `received_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `processed_at` DATETIME(0) NULL,
    PRIMARY KEY (`id`),
    UNIQUE INDEX `uq_livekit_webhook_id`(`webhook_id`),
    INDEX `idx_livekit_webhooks_pending`(`egress_id`, `processed_at`, `event_created_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
