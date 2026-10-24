-- Additive patch; no data is removed.
ALTER TABLE posts
  ADD COLUMN shared_post_id BIGINT UNSIGNED NULL,
  ADD COLUMN is_repost BOOLEAN NOT NULL DEFAULT FALSE,
  ADD INDEX idx_posts_original (shared_post_id),
  ADD CONSTRAINT fk_posts_original FOREIGN KEY (shared_post_id) REFERENCES posts(id) ON DELETE SET NULL;
CREATE TABLE saved_posts (
  user_id BIGINT UNSIGNED NOT NULL,
  post_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, post_id),
  INDEX idx_saved_posts_post (post_id),
  CONSTRAINT fk_saved_posts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_saved_posts_post FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);
