CREATE TABLE `story_reactions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `story_id` BIGINT UNSIGNED NOT NULL,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `reaction` VARCHAR(16) NOT NULL,
  `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_story_reaction` (`story_id`,`user_id`),
  KEY `idx_story_reactions_story` (`story_id`,`reaction`),
  CONSTRAINT `fk_story_reactions_story` FOREIGN KEY (`story_id`) REFERENCES `stories` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_story_reactions_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
