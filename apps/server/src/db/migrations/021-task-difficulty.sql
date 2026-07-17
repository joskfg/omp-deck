-- 021-task-difficulty.sql
--
-- T-109: add `difficulty` field to tasks (easy | medium | hard).
-- Default 'medium' — backfills existing rows without a difficulty set.

ALTER TABLE tasks ADD COLUMN difficulty TEXT NOT NULL DEFAULT 'medium';
