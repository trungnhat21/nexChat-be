ALTER TABLE `messages`
  ADD COLUMN `delivered_at` DATETIME NULL AFTER `updated_at`;
