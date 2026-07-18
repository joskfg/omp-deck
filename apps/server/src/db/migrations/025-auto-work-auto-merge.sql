-- 025-auto-work-auto-merge.sql
--
-- Fully-autonomous mode. `auto_work_config.auto_merge` opts a workspace into
-- arming GitHub auto-merge on a successful run's PR (CI is the reviewer) and
-- promoting the task to `done` once merged, instead of parking it in
-- `validate` for a human. `auto_work_runs.pr_number` persists the PR a
-- `completed_pending_merge` run is waiting on, so the reconciler can poll it
-- across server restarts without re-deriving it from a possibly-deleted branch.

ALTER TABLE auto_work_config ADD COLUMN auto_merge INTEGER NOT NULL DEFAULT 0;
ALTER TABLE auto_work_runs ADD COLUMN pr_number INTEGER;
