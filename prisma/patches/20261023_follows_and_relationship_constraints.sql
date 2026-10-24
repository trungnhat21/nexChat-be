-- Keep follow as a separate one-way relationship and prevent reciprocal duplicate
-- friendship rows (including concurrent requests in opposite directions).
CREATE TABLE follows (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  follower_id BIGINT UNSIGNED NOT NULL,
  following_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_follow (follower_id, following_id),
  KEY idx_follows_following (following_id),
  CONSTRAINT fk_follows_follower FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_follows_following FOREIGN KEY (following_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chk_follows_not_self CHECK (follower_id <> following_id)
);

ALTER TABLE friendships
  ADD COLUMN user_low_id BIGINT UNSIGNED NULL,
  ADD COLUMN user_high_id BIGINT UNSIGNED NULL;

-- Store the normalized pair explicitly. This avoids generated-column support
-- differences across MariaDB versions and lets the unique key enforce pairs.
UPDATE friendships
SET user_low_id = LEAST(requester_id, addressee_id),
    user_high_id = GREATEST(requester_id, addressee_id);

ALTER TABLE friendships
  MODIFY COLUMN user_low_id BIGINT UNSIGNED NOT NULL,
  MODIFY COLUMN user_high_id BIGINT UNSIGNED NOT NULL;

-- Existing opposite-direction rows can exist because the old unique key was
-- directional. Keep the strongest state, then the oldest row, before constraining.
DELETE f1 FROM friendships f1
JOIN friendships f2
  ON f1.user_low_id = f2.user_low_id
 AND f1.user_high_id = f2.user_high_id
 AND (
   CASE f1.status WHEN 'blocked' THEN 4 WHEN 'accepted' THEN 3 WHEN 'pending' THEN 2 ELSE 1 END
     < CASE f2.status WHEN 'blocked' THEN 4 WHEN 'accepted' THEN 3 WHEN 'pending' THEN 2 ELSE 1 END
   OR (CASE f1.status WHEN 'blocked' THEN 4 WHEN 'accepted' THEN 3 WHEN 'pending' THEN 2 ELSE 1 END
       = CASE f2.status WHEN 'blocked' THEN 4 WHEN 'accepted' THEN 3 WHEN 'pending' THEN 2 ELSE 1 END AND f1.id > f2.id)
 );

ALTER TABLE friendships
  ADD UNIQUE KEY uq_friendship_pair (user_low_id, user_high_id),
  ADD CONSTRAINT chk_friendship_not_self CHECK (requester_id <> addressee_id);
