-- Additive private-messaging constraints. Existing conversations/messages are retained.
ALTER TABLE conversations
  ADD COLUMN direct_user_low_id BIGINT UNSIGNED NULL,
  ADD COLUMN direct_user_high_id BIGINT UNSIGNED NULL,
  ADD UNIQUE KEY uq_conversation_direct_pair (direct_user_low_id, direct_user_high_id),
  ADD CONSTRAINT fk_conversations_direct_low
    FOREIGN KEY (direct_user_low_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT fk_conversations_direct_high
    FOREIGN KEY (direct_user_high_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE;

-- Preserve old direct conversations by assigning one canonical row per user pair.
-- Other legacy duplicate rows remain untouched and accessible; new requests reuse the canonical row.
CREATE TEMPORARY TABLE direct_conversation_pair_backfill AS
SELECT MIN(pairs.conversation_id) AS conversation_id,
       pairs.user_low_id,
       pairs.user_high_id
FROM (
  SELECT c.id AS conversation_id,
         MIN(cm.user_id) AS user_low_id,
         MAX(cm.user_id) AS user_high_id
  FROM conversations c
  JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.left_at IS NULL
  WHERE c.type = 'direct'
  GROUP BY c.id
  HAVING COUNT(DISTINCT cm.user_id) = 2
) AS pairs
GROUP BY pairs.user_low_id, pairs.user_high_id;

UPDATE conversations c
JOIN direct_conversation_pair_backfill b ON b.conversation_id = c.id
SET c.direct_user_low_id = b.user_low_id,
    c.direct_user_high_id = b.user_high_id;

DROP TEMPORARY TABLE direct_conversation_pair_backfill;

ALTER TABLE messages
  ADD COLUMN client_message_id VARCHAR(64) NULL,
  ADD UNIQUE KEY uq_messages_conversation_sender_client_id (conversation_id, sender_id, client_message_id),
  ADD KEY idx_messages_conversation_id (conversation_id, id);
