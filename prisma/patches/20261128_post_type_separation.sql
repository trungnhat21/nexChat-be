ALTER TABLE `posts`
  ADD COLUMN `post_type` ENUM('post', 'video') NOT NULL DEFAULT 'post' AFTER `content`,
  ADD KEY `idx_posts_type_created_at` (`post_type`, `created_at`, `id`);
