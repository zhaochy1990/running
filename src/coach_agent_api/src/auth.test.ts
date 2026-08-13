import assert from "node:assert/strict";
import test from "node:test";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { AuthError, createJwtVerifier } from "./auth.js";

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

test("verifier rejects missing tokens", async () => {
	const { publicKey } = await generateKeyPair("RS256");
	const verifier = await createJwtVerifier({
		publicKeyPem: await exportSPKI(publicKey),
		issuer: "auth-service",
	});
	await assert.rejects(() => verifier.verify(undefined), AuthError);
});
