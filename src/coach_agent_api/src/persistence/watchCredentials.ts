/**
 * Watch-binding reader for the lottery draw hard gate (#865, epic #862).
 *
 * The draw must not trust the client's "已绑表" state, so it re-derives it from
 * the canonical store — the same rows Go's `GET /api/users/me/watch` reads:
 *
 *   - bound + logged in ⇔ the latest provider_credentials row for the user
 *     carries a non-empty secret (ADR 0018 presence-only semantics, mirrored
 *     from Go's `len(cred.Secret) > 0`);
 *   - provider_key = `${provider}:${account}` with account = provider_user_id
 *     (stable, preferred) falling back to email (lower-cased). This is the
 *     anti-fraud key behind uk_activity_provider: the same COROS/Garmin
 *     account bound to a second stride account cannot re-draw an activity.
 *
 * Read-only against the stride DB (the same credential the API already uses
 * read-only for coach data); OCTET_LENGTH inspects the secret's size without
 * ever transferring the credential blob itself.
 */
import type { Pool, RowDataPacket } from "mysql2/promise";

/** provider_credentials.provider is varchar(32); keep provider + ":" + account inside varchar(255). */
const MAX_ACCOUNT_CHARS = 220;

export interface WatchCredential {
  /** `${provider}:${account}` — stored on the participation, enforced by uk_activity_provider. */
  providerKey: string;
}

/** Narrow port the lottery draw route consumes. */
export interface WatchCredentialReader {
  /**
   * The user's logged-in watch, or null when no credential row exists, the
   * secret is empty (not logged in), or no stable account identifier is
   * available (provider_key could not be composed).
   */
  getLoggedInWatch(userId: string): Promise<WatchCredential | null>;
}

export class MySqlWatchCredentialReader implements WatchCredentialReader {
  constructor(private readonly pool: Pool) {}

  async getLoggedInWatch(userId: string): Promise<WatchCredential | null> {
    // Latest row first — same ordering Go's ProviderForUser uses to decide
    // which provider is "the" watch for a user.
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT provider, email, provider_user_id, OCTET_LENGTH(secret) AS secret_bytes
         FROM provider_credentials WHERE user_id=? ORDER BY updated_at DESC LIMIT 1`,
      [userId],
    );
    const row = rows[0];
    if (row === undefined || Number(row.secret_bytes) === 0) return null;

    const account = accountIdentifier(row);
    if (account === null) return null;
    return { providerKey: `${row.provider as string}:${account}` };
  }
}

function accountIdentifier(row: RowDataPacket): string | null {
  const providerUserId = typeof row.provider_user_id === "string" ? row.provider_user_id.trim() : "";
  if (providerUserId.length > 0) return clip(providerUserId);
  const email = typeof row.email === "string" ? row.email.trim().toLowerCase() : "";
  if (email.length > 0) return clip(email);
  return null;
}

function clip(account: string): string {
  return account.length > MAX_ACCOUNT_CHARS ? account.slice(0, MAX_ACCOUNT_CHARS) : account;
}
