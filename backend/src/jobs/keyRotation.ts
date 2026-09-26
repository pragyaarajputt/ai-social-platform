import { prisma } from "../config/database.js";
import { currentKeyVersion, decryptToken, encryptToken } from "../utils/tokenCrypto.js";

// After a key rotation (a new key first in TOKEN_ENCRYPTION_KEYS), re-encrypts everything still
// stored with an older key, a batch per run. Each row is written only if it still holds the value we
// read, so a token refreshed at the same moment is never overwritten with the older token.

const BATCH = 500;

export interface RotationSummary {
  tokens: number;
  connectStates: number;
}

export async function reencryptOldTokens(): Promise<RotationSummary> {
  const current = `${currentKeyVersion()}:`;
  const summary: RotationSummary = { tokens: 0, connectStates: 0 };

  const tokens = await prisma.oAuthToken.findMany({
    where: { OR: [{ NOT: { accessTokenEnc: { startsWith: current } } }, { refreshTokenEnc: { not: null }, NOT: { refreshTokenEnc: { startsWith: current } } }] },
    select: { socialAccountId: true, accessTokenEnc: true, refreshTokenEnc: true },
    take: BATCH,
  });
  for (const t of tokens) {
    const { count } = await prisma.oAuthToken.updateMany({
      where: { socialAccountId: t.socialAccountId, accessTokenEnc: t.accessTokenEnc, refreshTokenEnc: t.refreshTokenEnc },
      data: {
        accessTokenEnc: reencrypt(t.accessTokenEnc, current),
        refreshTokenEnc: t.refreshTokenEnc ? reencrypt(t.refreshTokenEnc, current) : null,
      },
    });
    summary.tokens += count;
  }

  // PKCE verifiers of connect attempts in progress (they live 10 minutes).
  const states = await prisma.oAuthConnectState.findMany({
    where: { codeVerifierEnc: { not: null }, NOT: { codeVerifierEnc: { startsWith: current } } },
    select: { id: true, codeVerifierEnc: true },
    take: BATCH,
  });
  for (const s of states) {
    const { count } = await prisma.oAuthConnectState.updateMany({
      where: { id: s.id, codeVerifierEnc: s.codeVerifierEnc },
      data: { codeVerifierEnc: reencrypt(s.codeVerifierEnc!, current) },
    });
    summary.connectStates += count;
  }
  return summary;
}

const reencrypt = (stored: string, currentPrefix: string) => (stored.startsWith(currentPrefix) ? stored : encryptToken(decryptToken(stored)));

/** How many stored secrets use each key version, for `npm run tokens:key-status`. */
export async function keyVersionCounts(): Promise<Record<string, number>> {
  const rows = await prisma.$queryRaw<{ version: string; count: bigint }[]>`
    SELECT split_part(value, ':', 1) AS version, count(*) AS count FROM (
      SELECT access_token_enc AS value FROM oauth_tokens
      UNION ALL SELECT refresh_token_enc FROM oauth_tokens WHERE refresh_token_enc IS NOT NULL
      UNION ALL SELECT code_verifier_enc FROM oauth_connect_states WHERE code_verifier_enc IS NOT NULL
    ) v GROUP BY 1 ORDER BY 1`;
  return Object.fromEntries(rows.map((r) => [r.version, Number(r.count)]));
}
