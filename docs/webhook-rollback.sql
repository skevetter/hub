BEGIN;

DO $rollback$
BEGIN
  LOCK TABLE organization_api_keys, daemon_enrollment_tokens IN SHARE ROW EXCLUSIVE MODE;

  IF EXISTS (
    SELECT 1
    FROM organization_api_keys
    WHERE 'events:send' = ANY(scopes) AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Revoke every events:send API key before rollback cleanup';
  END IF;

  UPDATE daemon_enrollment_tokens AS token
  SET expires_at = LEAST(token.expires_at, CURRENT_TIMESTAMP)
  FROM organization_api_keys AS key
  WHERE token.issued_by_api_key_id = key.id
    AND 'events:send' = ANY(key.scopes)
    AND key.revoked_at IS NOT NULL
    AND token.consumed_at IS NULL;

  UPDATE daemon_enrollment_tokens AS token
  SET issued_by_api_key_id = NULL
  FROM organization_api_keys AS key
  WHERE token.issued_by_api_key_id = key.id
    AND 'events:send' = ANY(key.scopes)
    AND cardinality(array_remove(key.scopes, 'events:send')) = 0
    AND key.revoked_at IS NOT NULL
    AND token.consumed_at IS NULL;

  DELETE FROM organization_api_keys
  WHERE 'events:send' = ANY(scopes)
    AND cardinality(array_remove(scopes, 'events:send')) = 0
    AND revoked_at IS NOT NULL;

  UPDATE organization_api_keys
  SET scopes = array_remove(scopes, 'events:send')
  WHERE 'events:send' = ANY(scopes) AND revoked_at IS NOT NULL;
END;
$rollback$;

COMMIT;
