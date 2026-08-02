import assert from "node:assert/strict";
import test from "node:test";

import {
  corosRowFromSecret,
  decodeGarthDump,
  garminRowFromSecret,
  maskEmail,
  secretNameToUserId,
  TransformError,
} from "../src/transform.js";

const UUID = "f10bc353-01ab-4db1-af9f-d9305ea9a532";

// Build a garth-style tokens_dump: base64(json([oauth1, oauth2])).
function garthDump(oauth1, oauth2) {
  return Buffer.from(JSON.stringify([oauth1, oauth2]), "utf8").toString("base64");
}

test("secretNameToUserId strips prefix and lowercases a UUID", () => {
  assert.equal(
    secretNameToUserId(`coros-config-${UUID.toUpperCase()}`, "coros-config"),
    UUID,
  );
});

test("secretNameToUserId rejects a non-UUID suffix (e.g. the numeric COROS id)", () => {
  assert.throws(
    () => secretNameToUserId("coros-config-123456789", "coros-config"),
    TransformError,
  );
  assert.throws(
    () => secretNameToUserId("coros-config-default", "coros-config"),
    TransformError,
  );
});

test("secretNameToUserId rejects a wrong prefix", () => {
  assert.throws(
    () => secretNameToUserId(`garmin-config-${UUID}`, "coros-config"),
    TransformError,
  );
});

test("corosRowFromSecret maps columns and produces a Go-compatible secret blob", () => {
  const secret = JSON.stringify({
    email: "runner@example.com",
    pwd_hash: "HHHH",
    access_token: "TTTT",
    region: "cn",
    user_id: "99887766", // COROS numeric account id -> provider_user_id
    provider: "coros", // extra field is ignored
  });
  const row = corosRowFromSecret(UUID, secret);

  assert.equal(row.user_id, UUID);
  assert.equal(row.provider, "coros");
  assert.equal(row.email, "runner@example.com");
  assert.equal(row.region, "cn");
  assert.equal(row.provider_user_id, "99887766");
  // Byte-identical to Go json.Marshal(secretBlob{PwdHash, AccessToken}):
  assert.equal(row.secret.toString("utf8"), '{"pwd_hash":"HHHH","access_token":"TTTT"}');
});

test("corosRowFromSecret turns empty optional fields into NULL", () => {
  const row = corosRowFromSecret(
    UUID,
    JSON.stringify({ pwd_hash: "H", access_token: "T", email: "", region: "", user_id: "" }),
  );
  assert.equal(row.email, null);
  assert.equal(row.region, null);
  assert.equal(row.provider_user_id, null);
});

test("corosRowFromSecret rejects a credential with no pwd_hash and no token", () => {
  assert.throws(
    () => corosRowFromSecret(UUID, JSON.stringify({ email: "x@y.z" })),
    TransformError,
  );
});

test("garminRowFromSecret decodes the garth dump into oauth1/oauth2", () => {
  const oauth1 = { oauth_token: "o1tok", oauth_token_secret: "o1sec", domain: "garmin.cn" };
  const oauth2 = { access_token: "o2tok", refresh_token: "o2ref", expires_at: 1893456000 };
  const secret = JSON.stringify({
    email: "g@example.com",
    region: "cn",
    tokens_dump: garthDump(oauth1, oauth2),
  });
  const row = garminRowFromSecret(UUID, secret);

  assert.equal(row.user_id, UUID);
  assert.equal(row.provider, "garmin");
  assert.equal(row.email, "g@example.com");
  assert.equal(row.region, "cn");
  assert.equal(row.provider_user_id, null); // no userName in a garth dump

  const blob = JSON.parse(row.secret.toString("utf8"));
  assert.deepEqual(Object.keys(blob), ["oauth1", "oauth2"]);
  assert.equal(blob.oauth1.oauth_token, "o1tok");
  assert.equal(blob.oauth2.access_token, "o2tok");
  assert.equal(blob.oauth2.expires_at, 1893456000);
});

test("garminRowFromSecret backfills oauth1.domain from region when absent", () => {
  const dump = garthDump({ oauth_token: "o1" }, { access_token: "o2" });
  const cn = JSON.parse(
    garminRowFromSecret(
      UUID,
      JSON.stringify({ email: "a@b.c", region: "cn", tokens_dump: dump }),
    ).secret.toString("utf8"),
  );
  assert.equal(cn.oauth1.domain, "garmin.cn");

  const global = JSON.parse(
    garminRowFromSecret(
      UUID,
      JSON.stringify({ email: "a@b.c", region: "global", tokens_dump: dump }),
    ).secret.toString("utf8"),
  );
  assert.equal(global.oauth1.domain, "garmin.com");
});

test("garminRowFromSecret defaults region to cn (Python GarminCredentials default)", () => {
  const dump = garthDump({ oauth_token: "o1" }, { access_token: "o2" });
  const row = garminRowFromSecret(
    UUID,
    JSON.stringify({ email: "a@b.c", tokens_dump: dump }),
  );
  assert.equal(row.region, "cn");
});

test("decodeGarthDump rejects a dump missing the oauth1 token", () => {
  const bad = garthDump({ oauth_token: "" }, { access_token: "o2" });
  assert.throws(() => decodeGarthDump(bad, "cn"), TransformError);
});

test("decodeGarthDump rejects non-array / short dumps", () => {
  const notArray = Buffer.from(JSON.stringify({ a: 1 }), "utf8").toString("base64");
  assert.throws(() => decodeGarthDump(notArray, "cn"), TransformError);
});

test("maskEmail hides the local part but keeps the domain", () => {
  assert.equal(maskEmail("runner@example.com"), "r*****@example.com");
  assert.equal(maskEmail(null), null);
  assert.equal(maskEmail("not-an-email"), null);
});
