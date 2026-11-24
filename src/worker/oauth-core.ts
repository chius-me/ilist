import { decryptCredential, encryptCredential } from './crypto';
import { HttpError } from './http';
import { bytesToBase64Url } from './shared/encoding';
import { publicOrigin } from './shared/origin';
import type { Env } from './types';

export { publicOrigin };

const STATE_TTL_MS = 10 * 60_000;

interface OAuthStateRow {
  state_hash: string;
  mount_id: string;
  verifier_ciphertext: string;
  expires_at: number;
}

function randomToken(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256(value: string): Promise<string> {
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

export async function createOAuthState(
  env: Env,
  mountId: string,
  now = Date.now(),
): Promise<{ state: string; verifier: string; challenge: string }> {
  const state = randomToken();
  const verifier = randomToken();
  const stateHash = await sha256(state);
  const challenge = await sha256(verifier);
  const verifierCiphertext = await encryptCredential({ verifier }, env.CREDENTIAL_MASTER_KEY, `oauth-state:${stateHash}`, {
    domain: 'oauth-states',
  });

  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_states WHERE mount_id = ? OR expires_at <= ?').bind(mountId, now),
    env.DB.prepare(
      'INSERT INTO oauth_states (state_hash, mount_id, verifier_ciphertext, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(stateHash, mountId, verifierCiphertext, now + STATE_TTL_MS, new Date(now).toISOString()),
  ]);
  return { state, verifier, challenge };
}

export async function consumeOAuthState(
  env: Env,
  state: string,
  now = Date.now(),
): Promise<{ mountId: string; verifier: string }> {
  if (!state) throw new HttpError(400, 'OAUTH_STATE_INVALID', 'OAuth state is invalid');
  const stateHash = await sha256(state);
  const row = await env.DB.prepare(
    'SELECT state_hash, mount_id, verifier_ciphertext, expires_at FROM oauth_states WHERE state_hash = ?',
  ).bind(stateHash).first<OAuthStateRow>();
  if (!row) throw new HttpError(400, 'OAUTH_STATE_INVALID', 'OAuth state is invalid');
  if (row.expires_at <= now) {
    await env.DB.prepare('DELETE FROM oauth_states WHERE state_hash = ?').bind(stateHash).run();
    throw new HttpError(400, 'OAUTH_STATE_EXPIRED', 'OAuth state has expired');
  }

  const consumed = await env.DB.prepare('DELETE FROM oauth_states WHERE state_hash = ? AND expires_at > ?')
    .bind(stateHash, now).run();
  if ((consumed.meta.changes ?? 0) !== 1) {
    throw new HttpError(400, 'OAUTH_STATE_INVALID', 'OAuth state is invalid');
  }
  const decrypted = await decryptCredential(row.verifier_ciphertext, env.CREDENTIAL_MASTER_KEY, `oauth-state:${stateHash}`, {
    domain: 'oauth-states',
  });
  if (!decrypted || typeof decrypted !== 'object' || typeof (decrypted as { verifier?: unknown }).verifier !== 'string') {
    throw new HttpError(400, 'OAUTH_STATE_INVALID', 'OAuth state is invalid');
  }
  return { mountId: row.mount_id, verifier: (decrypted as { verifier: string }).verifier };
}

export async function deleteExpiredOAuthStates(
  db: D1Database,
  now = Date.now(),
  limit = 100,
): Promise<void> {
  await db.prepare(
    `DELETE FROM oauth_states
     WHERE state_hash IN (
       SELECT state_hash FROM oauth_states
       WHERE expires_at <= ?
       ORDER BY expires_at ASC
       LIMIT ?
     )`,
  ).bind(now, limit).run();
}
