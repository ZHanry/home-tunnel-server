import {
  canonical,
  publicJwk,
  strictJson,
  thumbprint,
  verifyJws,
  type PublicJwk,
} from "./crypto.js";

export type KeyEntry = {
  kid: string;
  alg: "ES256";
  public_jwk: PublicJwk;
  not_before: string;
  not_after: string;
};
export type Keyset = { keyset_version: number; active_kid: string; keys: KeyEntry[] };
export type KeysetManifest = Keyset & { server_instance_id: string; rotation_proofs: string[] };
const reject = (): never => {
  throw new Error("Invalid or untrusted RD keyset");
};
const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return reject();
  return v as Record<string, unknown>;
};
const fields = (v: Record<string, unknown>, expected: string[]) => {
  if (Object.keys(v).sort().join() !== expected.sort().join()) reject();
};
const time = (v: unknown) => {
  if (
    typeof v !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v) ||
    !Number.isFinite(Date.parse(v))
  )
    return reject();
  return Date.parse(v);
};
export function parseKeyset(value: unknown): Keyset {
  const set = record(value);
  fields(set, ["keyset_version", "active_kid", "keys"]);
  if (
    !Number.isSafeInteger(set.keyset_version) ||
    Number(set.keyset_version) < 1 ||
    typeof set.active_kid !== "string" ||
    !Array.isArray(set.keys) ||
    !set.keys.length ||
    set.keys.length > 8
  )
    return reject();
  const kids = new Set<string>();
  for (const item of set.keys) {
    const key = record(item);
    fields(key, ["kid", "alg", "public_jwk", "not_before", "not_after"]);
    if (
      key.alg !== "ES256" ||
      key.kid !== thumbprint(publicJwk(key.public_jwk)) ||
      kids.has(String(key.kid)) ||
      time(key.not_before) >= time(key.not_after)
    )
      return reject();
    kids.add(String(key.kid));
  }
  if (!kids.has(set.active_kid)) return reject();
  return set as Keyset;
}
export function parseManifest(text: string): KeysetManifest {
  if (Buffer.byteLength(text) > 262144) return reject();
  const value = record(strictJson(text));
  fields(value, ["server_instance_id", "keyset_version", "active_kid", "keys", "rotation_proofs"]);
  if (
    typeof value.server_instance_id !== "string" ||
    !value.server_instance_id ||
    !Array.isArray(value.rotation_proofs) ||
    value.rotation_proofs.length > 32 ||
    value.rotation_proofs.some((p) => typeof p !== "string" || p.length > 8192)
  )
    return reject();
  parseKeyset({
    keyset_version: value.keyset_version,
    active_kid: value.active_kid,
    keys: value.keys,
  });
  return value as KeysetManifest;
}
export const keysetBody = (set: Keyset): Keyset => ({
  keyset_version: set.keyset_version,
  active_kid: set.active_kid,
  keys: set.keys,
});
export function verifyKeysetUpdate(
  trusted: KeysetManifest,
  target: KeysetManifest,
  now = Date.now(),
): KeysetManifest {
  if (
    target.server_instance_id !== trusted.server_instance_id ||
    target.keyset_version < trusted.keyset_version
  )
    return reject();
  let current = keysetBody(trusted);
  let previousIssued = 0;
  for (const compact of target.rotation_proofs) {
    // Header/payload decoding is used only to select a relevant proof; trust starts at verifyJws.
    const pieces = compact.split(".");
    if (pieces.length !== 3) return reject();
    const untrusted = record(
      strictJson(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(pieces[1]!, "base64url")),
      ),
    );
    if (typeof untrusted.to_version === "number" && untrusted.to_version <= trusted.keyset_version)
      continue;
    const old = current.keys.find((k) => k.kid === current.active_kid)!;
    const payload = verifyJws(compact, old.public_jwk, "ht-rd-keyset+jwt");
    const header = record(strictJson(Buffer.from(pieces[0]!, "base64url").toString("utf8")));
    fields(payload, [
      "server_instance_id",
      "from_version",
      "to_version",
      "from_kid",
      "issued_at",
      "keyset",
    ]);
    const issued = time(payload.issued_at);
    if (
      header.kid !== old.kid ||
      payload.server_instance_id !== trusted.server_instance_id ||
      payload.from_version !== current.keyset_version ||
      payload.to_version !== current.keyset_version + 1 ||
      payload.from_kid !== old.kid ||
      issued < time(old.not_before) ||
      issued >= time(old.not_after) ||
      issued > now + 60000 ||
      issued < previousIssued
    )
      return reject();
    const next = parseKeyset(payload.keyset);
    const active = next.keys.find((k) => k.kid === next.active_kid)!;
    if (
      next.keyset_version !== payload.to_version ||
      next.active_kid === old.kid ||
      time(active.not_before) > issued ||
      time(active.not_after) <= issued
    )
      return reject();
    current = next;
    previousIssued = issued;
  }
  if (canonical(current) !== canonical(keysetBody(target))) return reject();
  const active = current.keys.find((k) => k.kid === current.active_kid)!;
  if (now < time(active.not_before) || now >= time(active.not_after)) return reject();
  return target;
}
export function genesisKeyset(
  instance: string,
  publicKey: PublicJwk,
  now = Date.now(),
): KeysetManifest {
  const kid = thumbprint(publicKey);
  return {
    server_instance_id: instance,
    keyset_version: 1,
    active_kid: kid,
    keys: [
      {
        kid,
        alg: "ES256",
        public_jwk: publicKey,
        not_before: new Date(now - 60000).toISOString(),
        not_after: new Date(now + 365 * 86400000).toISOString(),
      },
    ],
    rotation_proofs: [],
  };
}
