ALTER TABLE `messages`
  MODIFY COLUMN `message_type` ENUM('text','image','audio','file','system') NOT NULL DEFAULT 'text';

ALTER TABLE `attachments`
  ADD COLUMN `duration_ms` INT NULL AFTER `file_size`;
