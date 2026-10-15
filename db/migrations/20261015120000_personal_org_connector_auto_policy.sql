-- migrate:up
-- Orgs created with a personal-org marker get an ordinary, editable
-- "All actions: Auto" rule instead of "Reads: Auto". Existing orgs and orgs
-- marked personal after insertion keep their current policies.
CREATE OR REPLACE FUNCTION seed_connector_read_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  policy_id bigint;
  personal_owner_id jsonb;
BEGIN
  -- Match readPersonalOrgOwnerId: only a nonempty string identifies a personal org.
  BEGIN
    personal_owner_id := (NEW.metadata::jsonb)->'personal_org_for_user_id';
  EXCEPTION WHEN invalid_text_representation THEN
    personal_owner_id := NULL;
  END;
  INSERT INTO write_approval_policies (organization_id, resource_class, operation_category)
  VALUES (
    NEW.id, 'connector_action',
    CASE WHEN jsonb_typeof(personal_owner_id) = 'string' AND personal_owner_id <> '""'::jsonb
      THEN NULL ELSE 'read' END
  ) RETURNING id INTO policy_id;
  INSERT INTO write_policy_action_effects (policy_id, action, effect)
  VALUES (policy_id, 'execute', 'auto');
  RETURN NEW;
END;
$$;

-- migrate:down
CREATE OR REPLACE FUNCTION seed_connector_read_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy_id bigint;
BEGIN
  INSERT INTO write_approval_policies (organization_id, resource_class, operation_category)
  VALUES (NEW.id, 'connector_action', 'read') RETURNING id INTO policy_id;
  INSERT INTO write_policy_action_effects (policy_id, action, effect)
  VALUES (policy_id, 'execute', 'auto');
  RETURN NEW;
END;
$$;
