import assert from "node:assert/strict";
import test from "node:test";
import { MySqlWatchCredentialReader } from "../../src/persistence/watchCredentials.js";

interface Statement {
  sql: string;
  values: unknown[] | undefined;
}

/** 只记 SQL 的假 pool：单条查询按预设行回放。 */
class FakePool {
  readonly statements: Statement[] = [];
  private rows: Record<string, unknown>[] = [];

  constructor(rows: Record<string, unknown>[] = []) {
    this.rows = rows;
  }

  async query(sql: string, values?: unknown[]): Promise<unknown> {
    this.statements.push({ sql, values });
    return [this.rows, []];
  }
}

function makeReader(rows: Record<string, unknown>[]) {
  const pool = new FakePool(rows);
  return { pool, credentialReader: new MySqlWatchCredentialReader(pool as never) };
}

test("getLoggedInWatch：SQL 直读 provider_credentials（OCTET_LENGTH 不搬 secret）、按 updated_at 取最新", async () => {
  const { pool, credentialReader } = makeReader([{ provider: "coros", email: "runner@example.com", provider_user_id: null, secret_bytes: 120 }]);
  const credential = await credentialReader.getLoggedInWatch("user-1");
  assert.deepEqual(credential, { providerKey: "coros:runner@example.com" });
  assert.equal(pool.statements.length, 1);
  assert.match(pool.statements[0]?.sql ?? "", /SELECT provider, email, provider_user_id, OCTET_LENGTH\(secret\) AS secret_bytes/);
  assert.match(pool.statements[0]?.sql ?? "", /FROM provider_credentials WHERE user_id=\? ORDER BY updated_at DESC LIMIT 1/);
  assert.deepEqual(pool.statements[0]?.values, ["user-1"]);
});

test("无凭证行 → null（未绑表）", async () => {
  const { credentialReader } = makeReader([]);
  assert.equal(await credentialReader.getLoggedInWatch("user-1"), null);
});

test("secret 为空（绑定但未登录，ADR 0018 presence-only）→ null", async () => {
  const { credentialReader } = makeReader([{ provider: "coros", email: "runner@example.com", provider_user_id: null, secret_bytes: 0 }]);
  assert.equal(await credentialReader.getLoggedInWatch("user-1"), null);
});

test("provider_user_id 优先于 email（稳定账号标识）", async () => {
  const { credentialReader } = makeReader([{ provider: "garmin", email: "garmin-runner@example.com", provider_user_id: "GARMIN-42", secret_bytes: 4096 }]);
  assert.deepEqual(await credentialReader.getLoggedInWatch("user-1"), { providerKey: "garmin:GARMIN-42" });
});

test("仅有 email → 小写归一（同一账号大小写变体收敛到同一防刷键）", async () => {
  const { credentialReader } = makeReader([{ provider: "coros", email: "Runner@Example.COM ", provider_user_id: null, secret_bytes: 64 }]);
  assert.deepEqual(await credentialReader.getLoggedInWatch("user-1"), { providerKey: "coros:runner@example.com" });
});

test("email 与 provider_user_id 双缺 → null（无法构造稳定防刷键，不放入场）", async () => {
  const { credentialReader } = makeReader([{ provider: "coros", email: null, provider_user_id: null, secret_bytes: 64 }]);
  assert.equal(await credentialReader.getLoggedInWatch("user-1"), null);
});

test("超长账号标识截断到 220（provider(32)+':' 落在 varchar(255) 内）", async () => {
  const longEmail = `${"a".repeat(300)}@example.com`;
  const { credentialReader } = makeReader([{ provider: "coros", email: longEmail, provider_user_id: null, secret_bytes: 64 }]);
  const credential = await credentialReader.getLoggedInWatch("user-1");
  assert.equal(credential?.providerKey.length, "coros:".length + 220);
});
