import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type convict from "convict";
import { loadConfig, resolveEnvironment } from "./config.js";

test("resolveEnvironment reads STRIDE_COACH_ENV only and defaults to local", () => {
  assert.equal(resolveEnvironment({ env: {} }), "local");
  assert.equal(resolveEnvironment({ env: { STRIDE_COACH_ENV: "staging" } }), "staging");
  // NODE_ENV is ignored — STRIDE uses STRIDE_COACH_ENV only.
  assert.equal(resolveEnvironment({ env: { NODE_ENV: "production" } }), "local");
  assert.equal(resolveEnvironment({ env: { STRIDE_COACH_ENV: "prod", NODE_ENV: "production" } }), "prod");
});

test("resolveEnvironment rejects anything outside local/dev/staging/prod", () => {
  for (const bad of ["production", "test", "development", "bad env!", "PROD", ""]) {
    assert.throws(() => resolveEnvironment({ env: { STRIDE_COACH_ENV: bad } }), /Unsupported environment/);
  }
});

test("loadConfig merges YAML files in order and returns the resolved config", () => {
  const root = mkdtempSync(join(tmpdir(), "stride-common-load-"));
  try {
    writeFileSync(join(root, "base.yaml"), "api:\n  host: base-host\n  port: 8081\n");
    writeFileSync(join(root, "env.yaml"), "api:\n  port: 9090\n");

    const schema = {
      api: {
        host: { format: String, default: "0.0.0.0" },
        port: { format: "int", default: 8080 },
      },
    };
    const config = loadConfig({ schema, configFiles: [join(root, "base.yaml"), join(root, "env.yaml")] });
    assert.deepEqual(config, { api: { host: "base-host", port: 9090 } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig applies environment-variable overrides via the schema", () => {
  const root = mkdtempSync(join(tmpdir(), "stride-common-env-"));
  try {
    writeFileSync(join(root, "c.yaml"), "api:\n  host: base-host\n  port: 8081\n");
    const schema = {
      api: {
        host: { format: String, default: "0.0.0.0", env: "API_HOST" },
        port: { format: "int", default: 8080, env: "API_PORT" },
      },
    };
    const config = loadConfig({
      schema,
      configFiles: [join(root, "c.yaml")],
      env: { API_HOST: "env-host", API_PORT: "7000" } as NodeJS.ProcessEnv,
    });
    assert.deepEqual(config, { api: { host: "env-host", port: 7000 } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig rejects unknown keys in strict mode and preserves them otherwise", () => {
  const root = mkdtempSync(join(tmpdir(), "stride-common-strict-"));
  try {
    writeFileSync(join(root, "c.yaml"), "api:\n  host: h\n  unknown_setting: true\n");
    const schema = { api: { host: { format: String, default: "0.0.0.0" } } };

    assert.throws(() => loadConfig({ schema, configFiles: [join(root, "c.yaml")] }), /not declared in the schema/);
    const lenient = (loadConfig({ schema, configFiles: [join(root, "c.yaml")], strict: false }) as unknown as Record<string, unknown>).api as Record<
      string,
      unknown
    >;
    assert.equal(lenient.unknown_setting, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig requires at least one config file", () => {
  assert.throws(() => loadConfig({ schema: {}, configFiles: [] }), /At least one config file path is required/);
});

test("convict YAML parser used by loadConfig handles String/Array schema items", () => {
  const root = mkdtempSync(join(tmpdir(), "stride-common-schema-"));
  try {
    writeFileSync(join(root, "c.yaml"), "models:\n  - name: m1\n    provider: openai-compatible\n");
    const schema = {
      models: { format: Array, default: [] },
    } as convict.Schema<{ models: unknown[] }>;
    const config = loadConfig({ schema, configFiles: [join(root, "c.yaml")], strict: false });
    assert.deepEqual(config, { models: [{ name: "m1", provider: "openai-compatible" }] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
