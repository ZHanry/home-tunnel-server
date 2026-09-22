import { bytes, canonicalJson, strictJson } from "./protocol.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export function base64url(value) {
  const content = bytes(value);
  let text = "";
  for (let i = 0; i < content.length; i += 16384) text += String.fromCharCode(...content.subarray(i, i + 16384));
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function unbase64url(value, maximum = 65536) {
  if (typeof value !== "string" || value.length > maximum * 4 / 3 + 4 || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) throw new Error("RD_PROOF_INVALID");
  const output = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
  if (output.length > maximum || base64url(output) !== value) throw new Error("RD_PROOF_INVALID");
  return output;
}
export async function sha256(value) { return new Uint8Array(await crypto.subtle.digest("SHA-256", typeof value === "string" ? encoder.encode(value) : bytes(value))); }
export function publicJwk(value) {
  if (!value || value.kty !== "EC" || value.crv !== "P-256" || unbase64url(value.x, 32).length !== 32 || unbase64url(value.y, 32).length !== 32 || "d" in value || "jku" in value) throw new Error("RD_PROOF_INVALID");
  return { crv: "P-256", kty: "EC", x: value.x, y: value.y };
}
export async function thumbprint(value) { return base64url(await sha256(JSON.stringify(publicJwk(value)))); }
export async function signJws(identity, payload, typ = "ht-rd-proof+jwt", includeJwk = false) {
  const header = { alg: "ES256", typ, ...(includeJwk ? { jwk: identity.jwk } : {}) };
  const body = `${base64url(encoder.encode(JSON.stringify(header)))}.${base64url(encoder.encode(JSON.stringify(payload)))}`;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, identity.privateKey, encoder.encode(body));
  if (signature.byteLength !== 64) throw new Error("RD_PROOF_INVALID");
  return `${body}.${base64url(signature)}`;
}
export async function verifyJws(compact, key, typ, { kid } = {}) {
  if (typeof compact !== "string" || compact.length > 65536) throw new Error("RD_PROOF_INVALID");
  const parts = compact.split(".");
  if (parts.length !== 3) throw new Error("RD_PROOF_INVALID");
  const header = strictJson(decoder.decode(unbase64url(parts[0], 2048)), 2048);
  if (header.alg !== "ES256" || header.typ !== typ || Object.keys(header).some((name) => !["alg", "typ", "kid"].includes(name)) || (kid !== undefined && header.kid !== kid)) throw new Error("RD_PROOF_INVALID");
  const signature = unbase64url(parts[2], 64);
  if (signature.length !== 64) throw new Error("RD_PROOF_INVALID");
  const imported = await crypto.subtle.importKey("jwk", publicJwk(key), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, imported, signature, encoder.encode(`${parts[0]}.${parts[1]}`))) throw new Error("RD_PROOF_INVALID");
  return strictJson(decoder.decode(unbase64url(parts[1], 49152)), 49152);
}

export async function verifyServerKeyset(previous, incoming, now = Math.floor(Date.now() / 1000)) {
  const reject = () => { throw new Error("RD_SERVER_TRUST_CHANGED"); };
  const time = (value) => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) reject();
    return Date.parse(value) / 1000;
  };
  const validate = async (set, at, requireActive = true) => {
    if (!Number.isSafeInteger(set.keyset_version) || set.keyset_version < 1 || !Array.isArray(set.keys) || set.keys.length < 1 || set.keys.length > 8 || new Set(set.keys.map((key) => key.kid)).size !== set.keys.length) reject();
    for (const key of set.keys) {
      if (key.alg !== "ES256" || key.kid !== await thumbprint(key.public_jwk) || time(key.not_before) >= time(key.not_after)) reject();
    }
    const active = set.keys.find((key) => key.kid === set.active_kid);
    if (!active || (requireActive && (time(active.not_before) > at || time(active.not_after) <= at))) reject();
    return { keyset_version: set.keyset_version, active_kid: set.active_kid, keys: set.keys };
  };
  if (typeof incoming.server_instance_id !== "string" || !incoming.server_instance_id || !Number.isSafeInteger(incoming.restore_epoch) || incoming.restore_epoch < 1 || !Array.isArray(incoming.rotation_proofs) || incoming.rotation_proofs.length > 32) reject();
  const target = await validate(incoming, now);
  if (previous) {
    if (incoming.server_instance_id !== previous.server_instance_id || incoming.restore_epoch < previous.restore_epoch || target.keyset_version < previous.keyset_version) reject();
    let trusted = await validate(previous, now, false), previousIssued = 0;
    for (const compact of incoming.rotation_proofs) {
      if (typeof compact !== "string" || compact.length > 65536 || compact.split(".").length !== 3) reject();
      const untrusted = strictJson(decoder.decode(unbase64url(compact.split(".")[1], 49152)), 49152);
      if (Number.isSafeInteger(untrusted.to_version) && untrusted.to_version <= trusted.keyset_version) continue;
      const signer = trusted.keys.find((key) => key.kid === trusted.active_kid);
      const claims = await verifyJws(compact, signer.public_jwk, "ht-rd-keyset+jwt", { kid: signer.kid });
      const issued = time(claims.issued_at);
      if (claims.server_instance_id !== incoming.server_instance_id || claims.from_version !== trusted.keyset_version || claims.to_version !== trusted.keyset_version + 1 || claims.from_kid !== trusted.active_kid || claims.keyset?.keyset_version !== claims.to_version || claims.keyset.active_kid === signer.kid || issued > now + 60 || issued < time(signer.not_before) || issued >= time(signer.not_after) || issued < previousIssued) reject();
      trusted = await validate(claims.keyset, issued); previousIssued = issued;
    }
    if (canonicalJson(trusted) !== canonicalJson(target)) reject();
  }
  return { ...target, server_instance_id: incoming.server_instance_id, restore_epoch: incoming.restore_epoch };
}

function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("home-tunnel-remote-identities", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("identities");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("RD_IDENTITY_STORAGE_UNAVAILABLE"));
    request.onblocked = () => reject(new Error("RD_IDENTITY_STORAGE_UNAVAILABLE"));
  });
}
async function stored(key, replacement) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction("identities", replacement ? "readwrite" : "readonly");
      const store = transaction.objectStore("identities");
      const operation = replacement ? store.put(replacement, key) : store.get(key);
      let result;
      operation.onsuccess = () => { result = operation.result; };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = transaction.onabort = () => reject(new Error("RD_IDENTITY_STORAGE_UNAVAILABLE"));
    });
  } finally { db.close(); }
}
export async function browserIdentity(serverId, userId) {
  if (!serverId || !userId) throw new Error("RD_AUTH_REQUIRED");
  const key = JSON.stringify([location.origin, serverId, userId]);
  async function obtain() {
    let identity = await stored(key);
    if (!identity) {
      const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
      const jwk = publicJwk(await crypto.subtle.exportKey("jwk", pair.publicKey));
      identity = { privateKey: pair.privateKey, jwk, jkt: await thumbprint(jwk) };
      await stored(key, identity);
    }
    if (identity.privateKey.extractable || identity.jkt !== await thumbprint(identity.jwk)) throw new Error("RD_PROOF_INVALID");
    return { ...identity,
      saveEndpoint: async (endpointId) => { identity.endpointId = endpointId; await stored(key, identity); },
      pinServer: async (keys) => {
        const trustKey = JSON.stringify(["server-trust", location.origin, userId]);
        await navigator.locks.request(`rd-trust:${trustKey}`, async () => {
          const previous = await stored(trustKey);
          if (!previous && identity.serverKeyDigest && identity.serverKeyDigest !== base64url(await sha256(canonicalJson(keys.keys)))) throw new Error("RD_SERVER_TRUST_CHANGED");
          const trusted = await verifyServerKeyset(previous, keys);
          await stored(trustKey, trusted);
          if (previous && trusted.restore_epoch !== previous.restore_epoch) throw new Error("RD_SERVER_RESTORED");
        });
      },
      rememberHost: async (id, fingerprint) => { identity.hosts ??= {}; identity.hosts[id] = fingerprint; await stored(key, identity); },
    };
  }
  if (!navigator.locks) throw new Error("RD_BROWSER_LOCKS_UNAVAILABLE");
  return navigator.locks.request(`rd-identity:${key}`, obtain);
}

export async function dpop(identity, token, nonce, method, url) {
  const endpoint = new URL(url, location.origin);
  endpoint.search = ""; endpoint.hash = "";
  if (endpoint.origin !== location.origin) throw new Error("RD_PROOF_INVALID");
  return signJws(identity, { htu: endpoint.href, htm: method.toUpperCase(), iat: Math.floor(Date.now() / 1000), jti: crypto.randomUUID(), ath: base64url(await sha256(token)), nonce }, "dpop+jwt", true);
}
