// transform.js — pure, dependency-free mapping from an Azure Key Vault watch
// credential secret to a `provider_credentials` MySQL row.
//
// Everything here is deterministic and side-effect free so it can be unit-tested
// without touching Azure or MySQL (see test/transform.test.js). The output is
// designed to be BYTE-COMPATIBLE with what the Go worker writes/reads:
//   - COROS  secret blob: src/go/internal/provider/coros/creds.go  (secretBlob)
//   - Garmin secret blob: src/go/internal/provider/garmin/creds.go (secretBlob)
//   - user_id validation: src/go/internal/storage/watch.go (canonicalUserID)

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Raised for a per-record problem; the CLI skips the record and keeps going. */
export class TransformError extends Error {}

/**
 * Extract the app UUID from an AKV secret name.
 *
 * Secret names are `<prefix>-<sanitized_user>` (Python `_keyvault_secret_name`).
 * A canonical UUID survives that sanitization unchanged, so we just strip the
 * prefix and validate. Non-UUID suffixes (e.g. `coros-config-default` or a
 * friendly slug) are rejected on purpose — the Go store's `canonicalUserID`
 * would reject them too, and this keeps the numeric COROS account id from ever
 * landing in the `user_id` primary key.
 *
 * @returns {string} canonical lowercase UUID
 */
export function secretNameToUserId(secretName, prefix) {
  const head = `${prefix}-`;
  if (!secretName.startsWith(head)) {
    throw new TransformError(
      `secret "${secretName}" does not start with expected prefix "${head}"`,
    );
  }
  const suffix = secretName.slice(head.length);
  if (!UUID_RE.test(suffix)) {
    throw new TransformError(
      `secret "${secretName}" suffix "${suffix}" is not a canonical UUID`,
    );
  }
  return suffix.toLowerCase();
}

/** Empty string -> null (matches Go's strOrNil so columns become NULL). */
function nullIfEmpty(value) {
  const s = typeof value === "string" ? value.trim() : value;
  return s ? s : null;
}

/**
 * Build a `provider_credentials` row from a COROS AKV secret.
 *
 * AKV secret JSON: { email, pwd_hash, access_token, region, user_id }
 *   - user_id here is the numeric COROS account id -> provider_user_id column.
 *   - the app UUID comes from `userId` (the secret-name suffix), not the JSON.
 *
 * Secret blob mirrors Go coros.secretBlob: {"pwd_hash":...,"access_token":...}
 * with the fields in that exact order (json.Marshal is field-order stable).
 */
export function corosRowFromSecret(userId, secretJson) {
  const data = parseJsonObject(secretJson, "coros");
  const pwdHash = str(data.pwd_hash);
  const accessToken = str(data.access_token);
  if (!pwdHash && !accessToken) {
    throw new TransformError(
      "coros secret has neither pwd_hash nor access_token (not logged in)",
    );
  }
  const blob = JSON.stringify({ pwd_hash: pwdHash, access_token: accessToken });
  return {
    user_id: userId,
    provider: "coros",
    email: nullIfEmpty(data.email),
    region: nullIfEmpty(data.region),
    provider_user_id: nullIfEmpty(data.user_id),
    secret: Buffer.from(blob, "utf8"),
  };
}

/**
 * Build a `provider_credentials` row from a Garmin AKV secret.
 *
 * AKV secret JSON: { email, region, tokens_dump }
 *   tokens_dump is garth Client.dumps() == base64(json([oauth1, oauth2])).
 *
 * Secret blob mirrors Go garmin.secretBlob: {"oauth1":...,"oauth2":...}
 * (display_name/user_name are omitempty and always empty here, so they are
 * omitted). provider_user_id is therefore NULL — same as Go's
 * CredentialsFromGarthDump path.
 */
export function garminRowFromSecret(userId, secretJson) {
  const data = parseJsonObject(secretJson, "garmin");
  const region = str(data.region) || "cn"; // Python GarminCredentials default
  const { oauth1, oauth2 } = decodeGarthDump(str(data.tokens_dump), region);
  const blob = JSON.stringify({ oauth1, oauth2 });
  return {
    user_id: userId,
    provider: "garmin",
    email: nullIfEmpty(data.email),
    region: nullIfEmpty(region),
    provider_user_id: null,
    secret: Buffer.from(blob, "utf8"),
  };
}

/**
 * Decode a garth `tokens_dump` into its oauth1/oauth2 objects.
 *
 * Faithful passthrough: we keep garth's raw dicts (the Go structs unmarshal them
 * by field name, so every field the Go worker needs is present, and any extra
 * garth fields are harmlessly preserved). We only backfill oauth1.domain from
 * the region when absent — exactly what Go's CredentialsFromGarthDump does.
 */
export function decodeGarthDump(dump, region) {
  const trimmed = (dump || "").trim();
  if (!trimmed) {
    throw new TransformError("garmin secret has empty tokens_dump");
  }
  let decoded;
  try {
    decoded = Buffer.from(trimmed, "base64").toString("utf8");
  } catch {
    throw new TransformError("garmin tokens_dump is not valid base64");
  }
  let parts;
  try {
    parts = JSON.parse(decoded);
  } catch {
    throw new TransformError("garmin tokens_dump does not decode to JSON");
  }
  if (!Array.isArray(parts) || parts.length < 2) {
    throw new TransformError("garmin tokens_dump must be [oauth1, oauth2]");
  }
  const oauth1 = parts[0];
  const oauth2 = parts[1];
  if (!oauth1 || typeof oauth1 !== "object" || !str(oauth1.oauth_token)) {
    throw new TransformError("garmin tokens_dump has no oauth1 token");
  }
  if (!str(oauth1.domain)) {
    oauth1.domain = region === "cn" ? "garmin.cn" : "garmin.com";
  }
  return { oauth1, oauth2: oauth2 && typeof oauth2 === "object" ? oauth2 : {} };
}

/**
 * Redact a row for logging. Never returns pwd_hash / access_token / tokens; the
 * secret is reduced to its byte length. Email is masked to keep PII out of logs.
 */
export function redactRow(row) {
  return {
    provider: row.provider,
    user_id: row.user_id,
    email: maskEmail(row.email),
    region: row.region ?? null,
    provider_user_id: row.provider_user_id ?? null,
    secret_bytes: row.secret ? row.secret.length : 0,
  };
}

export function maskEmail(email) {
  if (!email || typeof email !== "string" || !email.includes("@")) return null;
  const [local, domain] = email.split("@");
  const head = local.slice(0, 1);
  return `${head}${"*".repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

function parseJsonObject(secretJson, provider) {
  let data;
  try {
    data = typeof secretJson === "string" ? JSON.parse(secretJson) : secretJson;
  } catch {
    throw new TransformError(`${provider} secret is not valid JSON`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new TransformError(`${provider} secret must be a JSON object`);
  }
  return data;
}

function str(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
