-- migrate:up
-- Quiesce writers: old servers treat role as editable profile text. Reconcile
-- that projection from authentication before exposing the permission selector.
UPDATE entity_types
SET metadata_schema = jsonb_set(
      jsonb_set(COALESCE(metadata_schema, '{"type":"object","properties":{}}'::jsonb),
        '{properties}', COALESCE(metadata_schema->'properties', '{}'::jsonb)),
      '{properties,role}', COALESCE(metadata_schema #> '{properties,role}', '{}'::jsonb)
        || '{"type":"string","enum":["owner","admin","member"]}'::jsonb),
    updated_at = current_timestamp
WHERE slug = '$member' AND deleted_at IS NULL;

-- Only authentication-owned claims can identify a permission-bearing member.
UPDATE entities e
SET metadata = COALESCE(e.metadata, '{}'::jsonb) || jsonb_build_object('role', m.role),
    updated_at = current_timestamp
FROM entity_types et, entity_identities ei, member m
WHERE et.id = e.entity_type_id AND et.slug = '$member'
  AND e.deleted_at IS NULL AND et.deleted_at IS NULL
  AND ei.entity_id = e.id AND ei.organization_id = e.organization_id
  AND ei.namespace = 'auth_user_id' AND ei.source_connector = 'auth:signup'
  AND ei.deleted_at IS NULL
  AND m."userId" = ei.identifier AND m."organizationId" = e.organization_id;

-- Pending invitations have no auth identity yet. Use the schema's email field.
UPDATE entities e
SET metadata = COALESCE(e.metadata, '{}'::jsonb) || jsonb_build_object('role', i.role),
    updated_at = current_timestamp
FROM entity_types et, invitation i
WHERE et.id = e.entity_type_id AND et.slug = '$member'
  AND e.deleted_at IS NULL AND et.deleted_at IS NULL
  AND i."organizationId" = e.organization_id AND i.status = 'pending'
  AND i.email = e.metadata->>COALESCE(
    (SELECT key FROM jsonb_each(et.metadata_schema->'properties')
     WHERE value->>'x-email' = 'true' LIMIT 1), 'email')
  AND NOT EXISTS (SELECT 1 FROM entity_identities ei WHERE ei.entity_id = e.id
    AND ei.organization_id = e.organization_id AND ei.namespace = 'auth_user_id'
    AND ei.source_connector = 'auth:signup' AND ei.deleted_at IS NULL);

-- migrate:down
-- Permission changes are intentionally not undone.
UPDATE entity_types
SET metadata_schema = metadata_schema #- '{properties,role,enum}', updated_at = current_timestamp
WHERE slug = '$member' AND deleted_at IS NULL;
