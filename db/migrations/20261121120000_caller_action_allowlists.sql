-- migrate:up
-- lobu:no-quiesce
CREATE TABLE IF NOT EXISTS caller_action_allowlists (
    organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    subject_kind text NOT NULL CHECK (subject_kind IN ('agent', 'pat')),
    subject_id text NOT NULL,
    entries jsonb NOT NULL CHECK (
        jsonb_typeof(entries) = 'array' AND jsonb_array_length(entries) <= 100
    ),
    PRIMARY KEY (organization_id, subject_kind, subject_id)
);

-- migrate:down
-- squawk-ignore ban-drop-table -- rollback of the allowlist table introduced above
DROP TABLE IF EXISTS caller_action_allowlists;
