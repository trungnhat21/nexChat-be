CREATE TABLE `stories` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `owner_id` BIGINT UNSIGNED NOT NULL,
  `media_key` VARCHAR(1000) NOT NULL,
  `media_type` VARCHAR(100) NOT NULL,
  `file_name` VARCHAR(255) NOT NULL,
  `file_size` BIGINT UNSIGNED NOT NULL,
  `caption` VARCHAR(500) NULL,
  `visibility` ENUM('public','friends','followers','private') NOT NULL DEFAULT 'friends',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expires_at` DATETIME(3) NOT NULL,
  `deleted_at` DATETIME NULL,
  PRIMARY KEY (`id`),
  KEY `idx_stories_owner_id` (`owner_id`,`id`),
  KEY `idx_stories_expiration` (`expires_at`,`id`),
  KEY `idx_stories_active_visibility` (`visibility`,`expires_at`,`id`),
  CONSTRAINT `fk_stories_owner` FOREIGN KEY (`owner_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `story_views` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `story_id` BIGINT UNSIGNED NOT NULL,
  `viewer_id` BIGINT UNSIGNED NOT NULL,
  `viewed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_story_view` (`story_id`,`viewer_id`),
  KEY `idx_story_views_viewer` (`viewer_id`,`viewed_at`),
  CONSTRAINT `fk_story_views_story` FOREIGN KEY (`story_id`) REFERENCES `stories` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_story_views_viewer` FOREIGN KEY (`viewer_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
