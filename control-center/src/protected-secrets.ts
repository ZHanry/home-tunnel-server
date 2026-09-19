import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { config } from "./config.js";

function key(purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", config.leaseSigningKey, "home-tunnel-7", purpose, 32));
}

// Separate keys and explicit context prevent session material being reused as
// encryption or lease credentials. Keep LEASE_SIGNING_KEY with disaster backups.
export function derivedToken(purpose: string, ...context: string[]): string {
  return createHmac("sha256", key(purpose)).update(JSON.stringify(context)).digest("base64url");
}

export function sessionCsrf(sessionId: string): string {
  return derivedToken("session-csrf", sessionId);
}

export function sealSecret(plain: string, context: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key("secret-storage"), nonce);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [
    "v1",
    nonce.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function openSecret(sealed: string, context: string): string {
  const [version, nonce, tag, ciphertext, extra] = sealed.split(".");
  if (version !== "v1" || !nonce || !tag || !ciphertext || extra)
    throw new Error("Invalid protected secret");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key("secret-storage"),
    Buffer.from(nonce, "base64url"),
  );
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
