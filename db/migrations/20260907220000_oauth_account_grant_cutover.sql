-- migrate:up
-- Credential cutover runs behind the existing deployment pause. Only the
-- observed ordinary apex/app resource class is revoked; an unknown resource,
-- scope or grant provenance is not evidence of an obsolete bare authorization.
WITH revoked_tokens AS (
  UPDATE oauth_tokens
  SET revoked_at = NOW()
  WHERE revoked_at IS NULL AND expires_at > NOW()
    AND user_id IS NOT NULL AND organization_id IS NOT NULL
    AND resource IN ('https://lobu.ai/mcp', 'https://app.lobu.ai/mcp')
    AND (authorization_grant_type IN ('authorization_code', 'device_code')
      OR authorization_grant_type IS NULL)
    AND regexp_split_to_array(btrim(COALESCE(scope, '')), '[[:space:]]+')
      <@ ARRAY['mcp:read', 'mcp:write', 'mcp:admin', 'profile:read']::text[]
  RETURNING id, client_id, user_id, organization_id
), deleted_authorization_codes AS (
  DELETE FROM oauth_authorization_codes
  WHERE used_at IS NULL AND expires_at > NOW()
    AND user_id IS NOT NULL AND organization_id IS NOT NULL
    AND resource IN ('https://lobu.ai/mcp', 'https://app.lobu.ai/mcp')
    AND regexp_split_to_array(btrim(COALESCE(scope, '')), '[[:space:]]+')
      <@ ARRAY['mcp:read', 'mcp:write', 'mcp:admin', 'profile:read']::text[]
  RETURNING code, client_id, user_id, organization_id
), deleted_device_codes AS (
  DELETE FROM oauth_device_codes
  WHERE status IN ('pending', 'approved') AND expires_at > NOW()
    AND user_id IS NOT NULL AND organization_id IS NOT NULL
    AND resource IN ('https://lobu.ai/mcp', 'https://app.lobu.ai/mcp')
    AND regexp_split_to_array(btrim(COALESCE(scope, '')), '[[:space:]]+')
      <@ ARRAY['mcp:read', 'mcp:write', 'mcp:admin', 'profile:read']::text[]
  RETURNING device_code, client_id, user_id, organization_id
), obsolete_subjects AS (
  SELECT client_id, user_id, organization_id FROM revoked_tokens
  UNION ALL SELECT client_id, user_id, organization_id FROM deleted_authorization_codes
  UNION ALL SELECT client_id, user_id, organization_id FROM deleted_device_codes
)
DELETE FROM mcp_sessions session
WHERE session.is_authenticated AND NOT session.scoped_to_org
  AND session.requested_agent_id IS NULL AND session.expires_at > NOW()
  AND EXISTS (
    SELECT 1 FROM obsolete_subjects subject
    WHERE subject.client_id = session.client_id AND subject.user_id = session.user_id
      AND subject.organization_id = session.organization_id
  )
  -- Sessions have no token/resource/provenance column. Any other live grant
  -- for this user and client makes attribution ambiguous, so retain that row
  -- for normal expiry and the runtime's current-binding recovery gate.
  AND NOT EXISTS (
    SELECT 1 FROM oauth_tokens token
    WHERE token.client_id = session.client_id AND token.user_id = session.user_id
      AND token.revoked_at IS NULL AND token.expires_at > NOW()
      AND NOT EXISTS (SELECT 1 FROM revoked_tokens revoked WHERE revoked.id = token.id)
  )
  AND NOT EXISTS (
    SELECT 1 FROM oauth_authorization_codes code
    WHERE code.client_id = session.client_id AND code.user_id = session.user_id
      AND code.used_at IS NULL AND code.expires_at > NOW()
      AND NOT EXISTS (SELECT 1 FROM deleted_authorization_codes deleted WHERE deleted.code = code.code)
  )
  AND NOT EXISTS (
    SELECT 1 FROM oauth_device_codes code
    WHERE code.client_id = session.client_id AND code.user_id = session.user_id
      AND code.status IN ('pending', 'approved') AND code.expires_at > NOW()
      AND NOT EXISTS (SELECT 1 FROM deleted_device_codes deleted WHERE deleted.device_code = code.device_code)
  );

-- Preserve missing snapshots only when another stored field proves an
-- explicit binding: the scoped resource names this exact organization, or a
-- verified device-code capability pins its worker. Never infer bare grants
-- from a former primary, and never replace an explicit empty/narrowed array.
UPDATE oauth_tokens token
SET granted_organization_ids = ARRAY[token.organization_id]::text[]
FROM organization org
WHERE token.organization_id = org.id AND token.granted_organization_ids IS NULL
  AND token.revoked_at IS NULL AND token.expires_at > NOW()
  AND (
    (token.resource ~ '^https?://[^/?#]+/mcp/[^/?#]+$'
      AND split_part(token.resource, '/', 5) = org.slug)
    OR (token.authorization_grant_type = 'device_code'
      AND regexp_split_to_array(btrim(COALESCE(token.scope, '')), '[[:space:]]+')
        @> ARRAY['device_worker:run']::text[])
  );

UPDATE oauth_authorization_codes code
SET granted_organization_ids = ARRAY[code.organization_id]::text[]
FROM organization org
WHERE code.organization_id = org.id AND code.granted_organization_ids IS NULL
  AND code.used_at IS NULL AND code.expires_at > NOW()
  AND code.resource ~ '^https?://[^/?#]+/mcp/[^/?#]+$'
  AND split_part(code.resource, '/', 5) = org.slug;

UPDATE oauth_device_codes code
SET granted_organization_ids = ARRAY[code.organization_id]::text[]
FROM organization org
WHERE code.organization_id = org.id AND code.granted_organization_ids IS NULL
  AND code.user_id IS NOT NULL AND code.status = 'approved' AND code.expires_at > NOW()
  AND (
    (code.resource ~ '^https?://[^/?#]+/mcp/[^/?#]+$'
      AND split_part(code.resource, '/', 5) = org.slug)
    OR regexp_split_to_array(btrim(COALESCE(code.scope, '')), '[[:space:]]+')
      @> ARRAY['device_worker:run']::text[]
  );

-- migrate:down
-- Revocation is irreversible: never resurrect credentials or recreate sessions.
