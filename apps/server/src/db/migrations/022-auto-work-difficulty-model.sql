-- 022-auto-work-difficulty-model.sql
--
-- T-109: per-workspace difficulty→agent mapping for auto-work.
-- Stored as JSON (same pattern as model_by_priority).
-- Absence of a key means "no override for this difficulty level".

ALTER TABLE auto_work_config ADD COLUMN model_by_difficulty TEXT NOT NULL DEFAULT '{}';
