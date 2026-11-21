-- migrate:up
-- lobu:no-quiesce
CREATE TABLE caller_action_allowlists (
    organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    subject_kind text NOT NULL CHECK (subject_kind IN ('agent', 'pat')),
    subject_id text NOT NULL,
    entries jsonb NOT NULL CHECK (
        jsonb_typeof(entries) = 'array' AND jsonb_array_length(entries) <= 100
    ),
    PRIMARY KEY (organization_id, subject_kind, subject_id)
);

-- migrate:down
DROP TABLE caller_action_allowlists;
