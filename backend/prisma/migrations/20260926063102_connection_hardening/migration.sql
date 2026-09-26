-- AlterTable
ALTER TABLE "oauth_connect_states" ADD COLUMN     "code_verifier_enc" TEXT;

-- One active workspace per platform account. Stop, rather than change data, if an account is
-- already active in several workspaces: someone has to choose which workspace keeps it.
DO $$
DECLARE
  duplicates TEXT;
BEGIN
  SELECT string_agg(platform::text || ' ' || external_id, ', ') INTO duplicates
  FROM (
    SELECT platform, external_id FROM social_accounts
    WHERE status IN ('ACTIVE', 'NEEDS_REAUTH')
    GROUP BY platform, external_id HAVING count(*) > 1
  ) d;
  IF duplicates IS NOT NULL THEN
    RAISE EXCEPTION 'These accounts are connected in more than one workspace: %. Disconnect all but one, then run the migration again.', duplicates;
  END IF;
END $$;

-- Disconnected and revoked rows hold no tokens and don't count, so the account can be connected elsewhere.
CREATE UNIQUE INDEX "social_accounts_one_active_workspace"
  ON "social_accounts" ("platform", "external_id")
  WHERE "status" IN ('ACTIVE', 'NEEDS_REAUTH');
