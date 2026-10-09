import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

// Public interoperability fixtures. The deterministic signing identity is for tests only.
const seed = createHash("sha256").update("NestLink api-v2 public interoperability fixture").digest();
const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
const publicKey = createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
const realm = createHash("sha256").update("NestLink fixture realm").digest("hex");
const claims = { v: 2, typ: "NestLink-P2P", jti: "11111111-1111-4111-8111-111111111111", realm, iat: 2_000_000_000, exp: 2_000_000_045,
  controller_device: "22222222-2222-4222-8222-222222222222", host_device: "33333333-3333-4333-8333-333333333333",
  controller_session: "44444444-4444-4444-8444-444444444444", host_session: "55555555-5555-4555-8555-555555555555",
  controller_id: "123456789", host_id: "987654321", controller_key: publicKey, host_key: publicKey, policy: "require_direct" };
const input = `nlp2.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
const permit = `${input}.${sign(null, Buffer.from(input), key).toString("base64url")}`;
const connectionId = "18446744073709551615";
const loginInput = `NestLink-login-v2:${permit}:${connectionId}`;
const bindingInput = `NestLink-binding-v2:${realm}:${claims.controller_device}:${claims.controller_id}`;
const fixture = { contract: "api-v2.0.0", test_only: true, now: claims.iat, trust: { algorithm: "Ed25519", public_key: publicKey, realm }, claims, permit,
  connection_id: connectionId, login_input: loginInput, login_proof: sign(null, Buffer.from(loginInput), key).toString("base64"),
  binding_input: bindingInput, binding_proof: sign(null, Buffer.from(bindingInput), key).toString("base64") };
const target = new URL("../contracts/nestlink-auth.v2-vectors.json", import.meta.url);
const content = JSON.stringify(fixture, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (await readFile(target, "utf8") !== content) throw new Error("Regenerate NestLink interoperability vectors");
} else await writeFile(target, content);
