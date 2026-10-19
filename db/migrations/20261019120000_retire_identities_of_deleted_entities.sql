-- migrate:up
-- lobu:no-quiesce -- old replicas during the roll can only leave a rare delete's identities live; provisioning now refuses that state loudly instead of hiding a member.
-- Deleting an entity left its identity rows live, so the live unique key
-- (organization, namespace, identifier, scope) kept a tombstoned record claiming an
-- email, login or chat id and blocked any live entity from holding it again.
-- A re-created $member then lacked its auth_user_id and member lookups missed
-- it. Entity soft-delete now retires identities in the same transaction; this
-- retires the rows earlier deletes left behind. Rows are soft-deleted, not
-- removed, and retain their entity_id for provenance.
UPDATE public.entity_identities ei
SET deleted_at = e.deleted_at,
    updated_at = current_timestamp
FROM public.entities e
WHERE e.id = ei.entity_id
  AND e.deleted_at IS NOT NULL
  AND ei.deleted_at IS NULL;

-- migrate:down
-- Irreversible by design: re-activating these rows would collide with any
-- live entity that has since claimed the same identifier.
SELECT 1;
