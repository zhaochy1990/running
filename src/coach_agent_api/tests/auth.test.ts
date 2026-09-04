import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { AuthError, createJwtVerifier, fetchAuthPublicKey } from "../src/auth.js";

test("RS256 verifier returns the authenticated subject", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const verifier = await createJwtVerifier({
    publicKeyPem: await exportSPKI(publicKey),
    issuer: "auth-service",
    audience: "stride-web",
  });
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setSubject("athlete-1")
    .setIssuer("auth-service")
    .setAudience("stride-web")
    .setExpirationTime("5m")
    .sign(privateKey);
  assert.deepEqual(await verifier.verify(`Bearer ${token}`), {
    userId: "athlete-1",
  });
});

test("RS256 verifier accepts any of the configured array audiences", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const verifier = await createJwtVerifier({
    publicKeyPem: await exportSPKI(publicKey),
    issuer: "auth-service",
    audience: ["stride-web", "stride-admin"],
  });
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setSubject("athlete-2")
    .setIssuer("auth-service")
    .setAudience("stride-admin")
    .setExpirationTime("5m")
    .sign(privateKey);
  assert.deepEqual(await verifier.verify(`Bearer ${token}`), {
    userId: "athlete-2",
  });
});

test("fetchAuthPublicKey parses the key and fails closed on errors", async () => {
  const pem = await exportSPKI((await generateKeyPair("RS256")).publicKey);
  let mode = "ok";
  const server = createServer((_req, res) => {
    if (mode === "error") {
      res.writeHead(500);
      res.end();
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(mode === "ok" ? JSON.stringify({ publickey: pem }) : JSON.stringify({ nope: true }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal(await fetchAuthPublicKey(base), pem);
    mode = "error";
    await assert.rejects(() => fetchAuthPublicKey(base), /500/);
    mode = "bad";
    await assert.rejects(() => fetchAuthPublicKey(base), /unexpected public-key payload/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("verifier rejects missing tokens", async () => {
  const { publicKey } = await generateKeyPair("RS256");
  const verifier = await createJwtVerifier({
    publicKeyPem: await exportSPKI(publicKey),
    issuer: "auth-service",
  });
  await assert.rejects(() => verifier.verify(undefined), AuthError);
});
