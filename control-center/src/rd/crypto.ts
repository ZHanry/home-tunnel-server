import {
  createHash,
  createPublicKey,
  sign,
  verify,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import { HttpError } from "../http.js";
import { loadSigningKey } from "./config.js";

export type PublicJwk = { kty: "EC"; crv: "P-256"; x: string; y: string };
export const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("base64url");
export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
};

// JSON.parse discards duplicate security fields. Parse bounded JSON before that can happen.
export function strictJson(text: string): unknown {
  let offset = 0;
  function space() {
    while (/[ \t\r\n]/.test(text[offset] ?? "") && offset < text.length) offset++;
  }
  function value(depth: number): unknown {
    if (depth > 20) throw new Error("JSON nesting limit");
    space();
    const current = text[offset];
    if (current === '"') {
      const start = offset++;
      while (offset < text.length) {
        const char = text[offset++];
        if (char === "\\") offset++;
        else if (char === '"') return JSON.parse(text.slice(start, offset)) as string;
      }
      throw new Error("Unterminated JSON string");
    }
    if (current === "{" || current === "[") {
      offset++;
      const array = current === "[",
        close = array ? "]" : "}";
      const list: unknown[] = [],
        object: Record<string, unknown> = Object.create(null),
        keys = new Set<string>();
      space();
      if (text[offset] === close) {
        offset++;
        return array ? list : object;
      }
      for (;;) {
        if (array) list.push(value(depth + 1));
        else {
          space();
          if (text[offset] !== '"') throw new Error("Invalid JSON key");
          const key = value(depth + 1) as string;
          if (keys.has(key) || keys.size >= 128)
            throw new Error("Duplicate or excessive JSON keys");
          keys.add(key);
          space();
          if (text[offset++] !== ":") throw new Error("Invalid JSON object");
          object[key] = value(depth + 1);
        }
        space();
        if (text[offset] === close) {
          offset++;
          return array ? list : object;
        }
        if (text[offset++] !== ",") throw new Error("Invalid JSON separator");
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
      text.slice(offset),
    );
    if (!match) throw new Error("Invalid JSON value");
    offset += match[0].length;
    const result = JSON.parse(match[0]) as unknown;
    if (
      typeof result === "number" &&
      (!Number.isFinite(result) || (Number.isInteger(result) && !Number.isSafeInteger(result)))
    )
      throw new Error("Unsafe JSON number");
    return result;
  }
  const result = value(0);
  space();
  if (offset !== text.length) throw new Error("Trailing JSON data");
  return result;
}

export function publicJwk(value: unknown): PublicJwk {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "RD_KEY_INVALID", "需要 P-256 公钥");
  const key = value as Record<string, unknown>;
  if (
    Object.keys(key).sort().join(",") !== "crv,kty,x,y" ||
    key.kty !== "EC" ||
    key.crv !== "P-256" ||
    typeof key.x !== "string" ||
    typeof key.y !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(key.x) ||
    !/^[A-Za-z0-9_-]{43}$/.test(key.y)
  )
    throw new HttpError(400, "RD_KEY_INVALID", "需要 P-256 公钥");
  try {
    createPublicKey({ key: key as JsonWebKey, format: "jwk" });
  } catch {
    throw new HttpError(400, "RD_KEY_INVALID", "公钥无效");
  }
  return key as PublicJwk;
}
export const thumbprint = (key: PublicJwk) =>
  digest(JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y }));
export function verifyJws(compact: string, key: PublicJwk, typ: string): Record<string, unknown> {
  try {
    if (compact.length > 65536) throw new Error();
    const parts = compact.split(".");
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) throw new Error();
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    const header = strictJson(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(headerPart, "base64url")),
    ) as Record<string, unknown>;
    if (
      !header ||
      header.alg !== "ES256" ||
      header.typ !== typ ||
      Object.keys(header).some((k) => !["alg", "typ", "jwk", "kid"].includes(k))
    )
      throw new Error();
    if (header.jwk && thumbprint(publicJwk(header.jwk)) !== thumbprint(key)) throw new Error();
    const signature = Buffer.from(signaturePart, "base64url");
    if (
      signature.length !== 64 ||
      !verify(
        "sha256",
        Buffer.from(`${headerPart}.${payloadPart}`),
        { key: createPublicKey({ key, format: "jwk" }), dsaEncoding: "ieee-p1363" },
        signature,
      )
    )
      throw new Error();
    const payload = strictJson(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(payloadPart, "base64url")),
    );
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error();
    return payload as Record<string, unknown>;
  } catch {
    throw new HttpError(401, "RD_PROOF_INVALID", "设备签名无效");
  }
}
let signingKey: KeyObject | undefined;
export function signer() {
  signingKey ??= loadSigningKey();
  return signingKey;
}
export function serverPublicKey() {
  const key = createPublicKey(signer()).export({ format: "jwk" });
  return publicJwk({ kty: key.kty, crv: key.crv, x: key.x, y: key.y });
}
export function signJws(payload: unknown, typ: string) {
  const header = Buffer.from(
    JSON.stringify({ alg: "ES256", typ, kid: thumbprint(serverPublicKey()) }),
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.${sign("sha256", Buffer.from(`${header}.${body}`), { key: signer(), dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
