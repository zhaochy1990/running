import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { formatUpdatedAt, parseGoDSN, parseMysqlConfig, splitSqlStatements } from "../src/mysql.js";

test("parseGoDSN parses a Tencent-style Go DSN", () => {
  const dsn = parseGoDSN(
    "stride:s3cr3t@tcp(gz-cdb-abc.sql.tencentcdb.com:3306)/stride?tls=true&parseTime=true",
  );
  assert.equal(dsn.user, "stride");
  assert.equal(dsn.password, "s3cr3t");
  assert.equal(dsn.host, "gz-cdb-abc.sql.tencentcdb.com");
  assert.equal(dsn.port, 3306);
  assert.equal(dsn.database, "stride");
  assert.equal(dsn.tls, "true");
});

test("parseGoDSN handles the local dev DSN without params", () => {
  const dsn = parseGoDSN("root:devroot@tcp(mysql:3306)/stride");
  assert.equal(dsn.user, "root");
  assert.equal(dsn.password, "devroot");
  assert.equal(dsn.host, "mysql");
  assert.equal(dsn.port, 3306);
  assert.equal(dsn.database, "stride");
  assert.equal(dsn.tls, null);
});

test("parseMysqlConfig prefers STRIDE_WORKER_MYSQL_DSN and maps tls to ssl", () => {
  const cfg = parseMysqlConfig({
    STRIDE_WORKER_MYSQL_DSN: "u:p@tcp(h:3307)/db?tls=true",
    MYSQL_HOST: "ignored",
  });
  assert.equal(cfg.host, "h");
  assert.equal(cfg.port, 3307);
  assert.equal(cfg.database, "db");
  assert.deepEqual(cfg.ssl, { rejectUnauthorized: true });
  assert.equal(cfg.timezone, "Z");
});

test("parseMysqlConfig falls back to discrete vars with skip-verify TLS", () => {
  const cfg = parseMysqlConfig({
    MYSQL_HOST: "127.0.0.1",
    MYSQL_PORT: "3306",
    MYSQL_USER: "root",
    MYSQL_PASSWORD: "pw",
    MYSQL_DATABASE: "stride",
    MYSQL_SSL: "skip-verify",
  });
  assert.equal(cfg.host, "127.0.0.1");
  assert.equal(cfg.user, "root");
  assert.deepEqual(cfg.ssl, { rejectUnauthorized: false });
});

test("parseMysqlConfig leaves ssl unset when TLS is off", () => {
  const cfg = parseMysqlConfig({ MYSQL_DATABASE: "stride" });
  assert.equal(cfg.ssl, undefined);
});

test("formatUpdatedAt emits MySQL datetime(6) UTC", () => {
  const s = formatUpdatedAt(new Date("2026-08-02T12:34:56.789Z"));
  assert.equal(s, "2026-08-02 12:34:56.789000");
});

test("splitSqlStatements drops -- comments and splits a multi-table DDL", () => {
  const ddl = `
-- a comment
CREATE TABLE a (
  id INT
);

-- another table
CREATE TABLE b (id INT);
`;
  const stmts = splitSqlStatements(ddl);
  assert.equal(stmts.length, 2);
  assert.match(stmts[0], /^CREATE TABLE a/);
  assert.match(stmts[1], /^CREATE TABLE b/);
  assert.equal(stmts[0].includes("-- a comment"), false);
});

test("splitSqlStatements splits the real schema.sql into its 7 CREATE TABLEs", () => {
  // Regression guard: schema.sql grew to 7 statements (3 identity/creds tables +
  // 4 health-domain tables); both migrations run --ensure-schema through
  // splitSqlStatements, so each must be a lone statement (mysql2 conn.query
  // rejects multiple statements). Comment lines contain ';'.
  const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "..", "schema.sql");
  const stmts = splitSqlStatements(readFileSync(schemaPath, "utf8"));
  assert.equal(stmts.length, 7);
  for (const s of stmts) {
    assert.match(s, /^CREATE TABLE IF NOT EXISTS/);
    assert.equal(s.includes("--"), false);
  }
  assert.ok(stmts.some((s) => s.includes("provider_credentials")));
  assert.ok(stmts.some((s) => s.includes("user_profile")));
  assert.ok(stmts.some((s) => s.includes("user_onboarding")));
  assert.ok(stmts.some((s) => s.includes("daily_health")));
  assert.ok(stmts.some((s) => s.includes("daily_hrv")));
  assert.ok(stmts.some((s) => s.includes("dashboard")));
  assert.ok(stmts.some((s) => s.includes("race_predictions")));
});
