-- Additive patch for existing databases without Prisma migration history.
ALTER TABLE profiles ADD COLUMN cover_url VARCHAR(500) NULL;
