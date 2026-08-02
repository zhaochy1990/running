import assert from "node:assert/strict";
import test from "node:test";

import { formatUpdatedAt, parseGoDSN, parseMysqlConfig } from "../src/mysql.js";

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
