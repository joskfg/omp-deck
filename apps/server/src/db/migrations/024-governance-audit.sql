-- 024-governance-audit.sql
--
-- T-35: audit trail for rule/extension governance changes (enable/disable)
-- and extension runtime load errors surfaced during session creation. One
-- generic table — mirrors 011-server-settings.sql's "don't build a table per
-- feature" precedent — since every row shape is (what changed, when, result).

CREATE TABLE IF NOT EXISTS governance_audit_events (
    id           TEXT PRIMARY KEY,
    occurred_at  TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('rule', 'extension', 'extension_load_error')),
    target_id    TEXT NOT NULL,
    action       TEXT NOT NULL CHECK (action IN ('enable', 'disable', 'load_error')),
    actor        TEXT NOT NULL DEFAULT 'user',
    cwd          TEXT,
    session_id   TEXT,
    before_json  TEXT,
    after_json   TEXT,
    result       TEXT NOT NULL CHECK (result IN ('ok', 'error')),
    error        TEXT
);

CREATE INDEX IF NOT EXISTS idx_governance_audit_events_occurred_at ON governance_audit_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_governance_audit_events_kind ON governance_audit_events(kind);
