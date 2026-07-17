-- 023-global-difficulty-model.sql
--
-- T-109: global difficulty→agent fallback mapping for auto-work.
-- Consulted when the per-workspace mapping has no entry for a difficulty level.
-- Stored as JSON (same pattern as task_selection_model).

ALTER TABLE auto_work_global_config ADD COLUMN model_by_difficulty TEXT NOT NULL DEFAULT '{}';
