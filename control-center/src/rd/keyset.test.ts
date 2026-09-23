import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import test from "node:test";
import type { KeysetManifest } from "./keyset.js";
process.env.NODE_ENV = "test";
process.env.SQLITE_PATH = ":memory:";
process.env.INTERNAL_SERVICE_KEY = "11".repeat(32);
process.env.FRPS_PLUGIN_KEY = "22".repeat(32);
process.env.LEASE_SIGNING_KEY = "33".repeat(32);
const { canonical, publicJwk, thumbprint } = await import("./crypto.js");
const { genesisKeyset, keysetBody, parseManifest, verifyKeysetUpdate } =
  await import("./keyset.js");

const now = Date.parse("2026-09-22T00:00:00.000Z");
function rotate(
  trusted: KeysetManifest,
  oldKey: KeyObject,
  instance = trusted.server_instance_id,
  issuedAt = now,
) {
  const fresh = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const next = genesisKeyset(
    instance,
    publicJwk(fresh.publicKey.export({ format: "jwk" })),
    issuedAt,
  );
  next.keyset_version = trusted.keyset_version + 1;
  const payload = {
    server_instance_id: instance,
    from_version: trusted.keyset_version,
    to_version: next.keyset_version,
    from_kid: trusted.active_kid,
    issued_at: new Date(issuedAt).toISOString(),
    keyset: keysetBody(next),
  };
  const header = Buffer.from(
      JSON.stringify({ alg: "ES256", typ: "ht-rd-keyset+jwt", kid: trusted.active_kid }),
    ).toString("base64url"),
    body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const proof = `${header}.${body}.${sign("sha256", Buffer.from(`${header}.${body}`), { key: oldKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
  next.rotation_proofs = [...trusted.rotation_proofs, proof];
  return { manifest: next, privateKey: fresh.privateKey };
}
test("RD keyset verifies chained rotations and rejects unsigned substitution, rollback and foreign instance", () => {
  const old = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const initial = genesisKeyset(
    "fixture-instance",
    publicJwk(old.publicKey.export({ format: "jwk" })),
    now,
  );
  const first = rotate(initial, old.privateKey),
    second = rotate(first.manifest, first.privateKey);
  assert.equal(verifyKeysetUpdate(initial, second.manifest, now).keyset_version, 3);
  assert.equal(verifyKeysetUpdate(first.manifest, second.manifest, now).keyset_version, 3);
  assert.throws(() => verifyKeysetUpdate(second.manifest, initial, now));
  assert.throws(() => verifyKeysetUpdate(initial, { ...first.manifest, rotation_proofs: [] }, now));
  assert.throws(() =>
    verifyKeysetUpdate(
      initial,
      { ...initial, keys: first.manifest.keys, active_kid: first.manifest.active_kid },
      now,
    ),
  );
  assert.throws(() =>
    verifyKeysetUpdate(initial, rotate(initial, old.privateKey, "other-instance").manifest, now),
  );
  assert.throws(() => verifyKeysetUpdate(initial, rotate(initial, first.privateKey).manifest, now));
  assert.throws(() =>
    verifyKeysetUpdate(
      initial,
      rotate(initial, old.privateKey, initial.server_instance_id, now + 120000).manifest,
      now,
    ),
  );
  assert.throws(() =>
    verifyKeysetUpdate(
      initial,
      rotate(initial, old.privateKey, initial.server_instance_id, now + 366 * 86400000).manifest,
      now + 366 * 86400000,
    ),
  );
  assert.throws(() =>
    verifyKeysetUpdate(
      initial,
      { ...second.manifest, rotation_proofs: second.manifest.rotation_proofs.slice(1) },
      now,
    ),
  );
  assert.equal(canonical(parseManifest(JSON.stringify(initial))), canonical(initial));
  assert.throws(() =>
    parseManifest(
      JSON.stringify({
        ...initial,
        keys: [{ ...initial.keys[0], kid: thumbprint(first.manifest.keys[0]!.public_jwk) }],
      }),
    ),
  );
  assert.throws(() =>
    parseManifest(
      JSON.stringify(initial).replace(
        '"keyset_version":1',
        '"keyset_version":1,"keyset_version":1',
      ),
    ),
  );
});
