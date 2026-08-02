// mysql.js — Tencent MySQL connection + upsert for provider_credentials.
//
// Connection can be configured two ways (Option A wins if present):
//   A) STRIDE_WORKER_MYSQL_DSN — the Go worker's DSN, verbatim:
//        user:pass@tcp(host:port)/dbname?tls=true
//   B) discrete MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD /
//      MYSQL_DATABASE (+ MYSQL_SSL)
//
// The upsert mirrors the Go store's clause.OnConflict{UpdateAll:true}
// (src/go/internal/storage/watch.go :: SaveCredential).

import mysql from "mysql2/promise";

/**
 * Parse a Go-style DSN: `user:pass@tcp(host:port)/dbname?params`.
 * @returns {{host:string,port:number,user:string,password:string,database:string,tls:string|null}}
 */
export function parseGoDSN(dsn) {
  const m =
    /^(?:([^:@/]+)(?::([^@/]*))?@)?tcp\(([^)]+)\)\/([^?]*)(?:\?(.*))?$/.exec(
      dsn.trim(),
    );
  if (!m) throw new Error(`could not parse STRIDE_WORKER_MYSQL_DSN: ${dsn}`);
  const [, user = "", password = "", address, database, query = ""] = m;
  const colon = address.lastIndexOf(":");
  const host = colon >= 0 ? address.slice(0, colon) : address;
  const port = colon >= 0 ? Number(address.slice(colon + 1)) : 3306;
  const params = new URLSearchParams(query);
  return {
    host,
    port,
    user,
    password,
    database,
    tls: params.get("tls"),
  };
}

/**
 * Resolve a mysql2 connection config from environment variables (pure).
 * @returns {{host:string,port:number,user:string,password:string,database:string,ssl?:object}}
 */
export function parseMysqlConfig(env) {
  let base;
  let sslHint;
  if (env.STRIDE_WORKER_MYSQL_DSN && env.STRIDE_WORKER_MYSQL_DSN.trim()) {
    const dsn = parseGoDSN(env.STRIDE_WORKER_MYSQL_DSN);
    base = dsn;
    sslHint = dsn.tls; // DSN tls= wins
  } else {
    base = {
      host: env.MYSQL_HOST || "127.0.0.1",
      port: Number(env.MYSQL_PORT || 3306),
      user: env.MYSQL_USER || "root",
      password: env.MYSQL_PASSWORD || "",
      database: env.MYSQL_DATABASE || "stride",
    };
    sslHint = env.MYSQL_SSL || null;
  }
  if (!base.database) throw new Error("MySQL database name is required");

  const config = {
    host: base.host,
    port: base.port,
    user: base.user,
    password: base.password,
    database: base.database,
    // datetime(6) values are handed in as pre-formatted UTC strings, so keep the
    // driver from re-interpreting them in a local zone.
    timezone: "Z",
    // BLOBs come back as Buffers (default), which is what we want.
  };
  const ssl = sslToOption(sslHint);
  if (ssl) config.ssl = ssl;
  return config;
}

function sslToOption(hint) {
  if (!hint) return null;
  const v = String(hint).trim().toLowerCase();
  if (v === "" || v === "false" || v === "0" || v === "off") return null;
  if (v === "skip-verify" || v === "insecure") {
    return { rejectUnauthorized: false };
  }
  // "true" / "require" / "preferred" / anything else -> TLS with cert verification
  return { rejectUnauthorized: true };
}

/** Format a Date as MySQL datetime(6) in UTC: `YYYY-MM-DD HH:MM:SS.ffffff`. */
export function formatUpdatedAt(date = new Date()) {
  // toISOString() -> 2026-08-02T12:34:56.789Z (millisecond precision)
  const iso = date.toISOString();
  return iso.slice(0, 10) + " " + iso.slice(11, 23) + "000";
}

export async function connect(config) {
  return mysql.createConnection(config);
}

/** Execute the CREATE TABLE IF NOT EXISTS DDL. */
export async function ensureSchema(conn, ddl) {
  await conn.query(ddl);
}

const UPSERT_SQL = `
INSERT INTO provider_credentials
  (user_id, provider, email, region, provider_user_id, secret, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE
  email = VALUES(email),
  region = VALUES(region),
  provider_user_id = VALUES(provider_user_id),
  secret = VALUES(secret),
  updated_at = VALUES(updated_at)`;

/**
 * Upsert one credential row.
 * @returns {Promise<"inserted"|"updated">}
 */
export async function upsertCredential(conn, row, updatedAt) {
  const [res] = await conn.execute(UPSERT_SQL, [
    row.user_id,
    row.provider,
    row.email,
    row.region,
    row.provider_user_id,
    row.secret,
    updatedAt,
  ]);
  // mysql affectedRows: 1 = inserted, 2 = updated (an existing row changed),
  // 0 = matched but identical.
  return res.affectedRows === 1 ? "inserted" : "updated";
}
