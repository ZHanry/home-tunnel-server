// Generates public-only, fixed-time verification vectors. Fixture private keys
// exist only in memory and are never exported. Run deliberately, not during CI.
import { generateKeyPairSync, createHash, sign } from "node:crypto";
import { writeFileSync } from "node:fs";

const hash = (value) => createHash("sha256").update(value).digest("base64url");
const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const source = publicKey.export({ format: "jwk" });
  const public_jwk = { crv: "P-256", kty: "EC", x: source.x, y: source.y };
  return { privateKey, public_jwk, jkt: hash(JSON.stringify(public_jwk)) };
};
const server = pair(), host = pair(), controller = pair();
const now = 1790035320;
const common = {
  iss: "https://rd-fixture.example.test", server_instance_id: "a0000000-0000-4000-8000-000000000001", restore_epoch: 2,
  session_id: "b0000000-0000-4000-8000-000000000001", session_request_id: "c0000000-0000-4000-8000-000000000001", connection_epoch: 3,
  owner_user_id: "d0000000-0000-4000-8000-000000000001", controller_endpoint_id: "e0000000-0000-4000-8000-000000000001", host_endpoint_id: "f0000000-0000-4000-8000-000000000001",
  controller_jkt: controller.jkt, host_jkt: host.jkt, permissions: ["view", "input.keyboard", "input.pointer", "input.text"],
  grant_id: "a1000000-0000-4000-8000-000000000001", grant_version: 4, user_token_version: 5, iat: now, nbf: now,
};
const grant = {
  id: common.grant_id, server_instance_id: common.server_instance_id, owner_user_id: common.owner_user_id,
  host_endpoint_id: common.host_endpoint_id, controller_endpoint_id: common.controller_endpoint_id, host_jkt: host.jkt, controller_jkt: controller.jkt,
  scope: common.permissions, mode: "one_session", one_session_request_id: common.session_request_id, grant_version: common.grant_version,
  expires_at: new Date((now + 3600) * 1000).toISOString(),
};
const ticket = { ...common, aud: "ht-rd-start", jti: "a2000000-0000-4000-8000-000000000001", exp: now + 60 };
const lease = { ...common, aud: "ht-rd-use", jti: "a3000000-0000-4000-8000-000000000001", exp: now + 900, lease_seq: 1 };
const compact = (identity, type, payload, kid) => {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", typ: type, ...(kid ? { kid } : {}) })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign("sha256", Buffer.from(`${header}.${body}`), { key: identity.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return [header, body, signature];
};
const publicIdentity = (identity) => ({ public_jwk: identity.public_jwk, jkt: identity.jkt });
const valid = {
  ticket: { claims: ticket, jws_parts: compact(server, "ht-rd-ticket+jwt", ticket, server.jkt) },
  lease: { claims: lease, jws_parts: compact(server, "ht-rd-lease+jwt", lease, server.jkt) },
  grant: { claims: grant, jws_parts: compact(host, "ht-rd-grant+jwt", grant) },
};
const rejected = [
  { name: "ticket_wrong_audience", kind: "ticket", claims: { ...ticket, aud: "ht-rd-use" } },
  { name: "ticket_wrong_epoch", kind: "ticket", claims: { ...ticket, connection_epoch: 2 } },
  { name: "ticket_wrong_request", kind: "ticket", claims: { ...ticket, session_request_id: "c0000000-0000-4000-8000-000000000002" } },
  { name: "ticket_wrong_owner", kind: "ticket", claims: { ...ticket, owner_user_id: "d0000000-0000-4000-8000-000000000002" } },
  { name: "ticket_expired", kind: "ticket", claims: { ...ticket, exp: now } },
  { name: "lease_widens_permissions", kind: "lease", claims: { ...lease, permissions: [...lease.permissions, "files.send"] } },
  { name: "lease_restore_rollback", kind: "lease", claims: { ...lease, restore_epoch: 1 } },
  { name: "lease_grant_version_rollback", kind: "lease", claims: { ...lease, grant_version: 3 } },
].map((item) => ({ ...item, jws_parts: compact(server, item.kind === "ticket" ? "ht-rd-ticket+jwt" : "ht-rd-lease+jwt", item.claims, server.jkt) }));
const fixture = {
  schema_version: 1, description: "Public-only verification fixture. Join jws_parts with a dot. No private fixture key is stored or used in production.",
  reference_time_unix: now, identities: { server: publicIdentity(server), host: publicIdentity(host), controller: publicIdentity(controller) },
  keyset: { server_instance_id: common.server_instance_id, restore_epoch: 2, keyset_version: 1, active_kid: server.jkt, rotation_proofs: [], keys: [{ kid: server.jkt, alg: "ES256", public_jwk: server.public_jwk, not_before: new Date((now - 3600) * 1000).toISOString(), not_after: new Date((now + 86400) * 1000).toISOString() }] },
  expected_binding: common, valid, rejected,
};
writeFileSync(new URL("../contracts/remote-authorization-vectors.json", import.meta.url), JSON.stringify(fixture, null, 2) + "\n");
console.log("Public authorization vectors written; no private keys exported.");
