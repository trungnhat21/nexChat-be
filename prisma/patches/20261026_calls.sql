-- CreateTable
CREATE TABLE `call_sessions` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `conversation_id` BIGINT UNSIGNED NOT NULL,
    `initiated_by` BIGINT UNSIGNED NOT NULL,
    `room_name` VARCHAR(128) NOT NULL,
    `call_type` ENUM('audio', 'video') NOT NULL,
    `status` ENUM('ringing', 'accepted', 'declined', 'cancelled', 'ended', 'failed') NOT NULL DEFAULT 'ringing',
    `idempotency_key` CHAR(36) NOT NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `accepted_at` DATETIME(0) NULL,
    `ended_at` DATETIME(0) NULL,
    `end_reason` ENUM('declined', 'cancelled', 'ended', 'failed', 'timeout') NULL,
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `uq_call_sessions_room`(`room_name`),
    INDEX `idx_call_sessions_conversation_state`(`conversation_id`, `status`, `created_at`),
    INDEX `idx_call_sessions_state_created`(`status`, `created_at`),
    INDEX `idx_call_sessions_initiator_created`(`initiated_by`, `created_at`),
    UNIQUE INDEX `uq_call_sessions_idempotency`(`initiated_by`, `idempotency_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `call_participants` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `call_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `role` ENUM('caller', 'callee') NOT NULL,
    `joined_at` DATETIME(0) NULL,
    `left_at` DATETIME(0) NULL,

    INDEX `idx_call_participants_user_call`(`user_id`, `call_id`),
    UNIQUE INDEX `uq_call_participant`(`call_id`, `user_id`),
    UNIQUE INDEX `uq_call_participant_role`(`call_id`, `role`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `call_sessions` ADD CONSTRAINT `fk_call_sessions_conversation` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `call_sessions` ADD CONSTRAINT `fk_call_sessions_initiator` FOREIGN KEY (`initiated_by`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `call_participants` ADD CONSTRAINT `fk_call_participants_call` FOREIGN KEY (`call_id`) REFERENCES `call_sessions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `call_participants` ADD CONSTRAINT `fk_call_participants_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
