-- Add a read timestamp so read notifications can be removed seven days later.
ALTER TABLE notifications
  ADD COLUMN read_at DATETIME NULL;

-- Preserve a full seven-day retention window for notifications already read.
UPDATE notifications
SET read_at = CURRENT_TIMESTAMP
WHERE is_read = 1 AND read_at IS NULL;

ALTER TABLE notifications
  MODIFY COLUMN type ENUM(
    'friend_request',
    'friend_accept',
    'message',
    'post_reaction',
    'comment',
    'comment_reaction',
    'new_post'
  ) NOT NULL,
  ADD KEY idx_notifications_read_at (is_read, read_at);
