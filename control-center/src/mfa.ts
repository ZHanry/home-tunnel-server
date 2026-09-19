import { createHmac, randomBytes } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import { HttpError } from "./http.js";
import { openSecret } from "./protected-secrets.js";
import { constantTimeStringEqual, opaqueToken, tokenHash } from "./security.js";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function newTotpSecret(): string {
  let bits = 0,
    value = 0,
    output = "";
  for (const byte of randomBytes(20)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += alphabet[(value >>> bits) & 31];
    }
  }
  return output;
}

export function totpCode(secret: string, counter: number): string {
  let bits = 0,
    value = 0;
  const decoded: number[] = [];
  for (const character of secret) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("Invalid TOTP secret");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      decoded.push((value >>> bits) & 255);
    }
  }
  const count = Buffer.alloc(8);
  count.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", Buffer.from(decoded)).update(count).digest();
  const offset = digest[digest.length - 1]! & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

export function matchingTotpCounter(
  secret: string,
  code: string,
  now = Date.now(),
  last = -1,
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 30_000);
  for (const counter of [current, current - 1, current + 1]) {
    if (counter > last && counter >= 0 && constantTimeStringEqual(totpCode(secret, counter), code))
      return counter;
  }
  return null;
}

// Must be called inside the transaction that authorizes the operation. A code
// is consumed atomically, so concurrent attempts cannot reuse a factor.
export async function verifyMfa(
  client: DatabaseClient,
  userId: string,
  code?: string,
): Promise<void> {
  const user = (
    await client.query<{ mfa_secret: string | null; mfa_last_counter: number }>(
      "SELECT mfa_secret,mfa_last_counter FROM users WHERE id=?",
      [userId],
    )
  ).rows[0];
  if (!user?.mfa_secret) return;
  if (!code) throw new HttpError(401, "MFA_REQUIRED", "请输入验证器动态码或一次性恢复码");
  const counter = matchingTotpCounter(
    openSecret(user.mfa_secret, `mfa:${userId}`),
    code,
    Date.now(),
    user.mfa_last_counter,
  );
  if (counter !== null) {
    await client.query("UPDATE users SET mfa_last_counter=? WHERE id=?", [counter, userId]);
    return;
  }
  const recovery = await client.query(
    "UPDATE mfa_recovery_codes SET used_at=home_tunnel_now() WHERE user_id=? AND code_hash=? AND used_at IS NULL RETURNING code_hash",
    [userId, tokenHash(code)],
  );
  if (recovery.rowCount) return;
  throw new HttpError(401, "MFA_INVALID", "动态码无效、已使用或已过期");
}

export async function replaceRecoveryCodes(
  client: DatabaseClient,
  userId: string,
): Promise<string[]> {
  const codes = Array.from({ length: 8 }, () => opaqueToken(16));
  await client.query("DELETE FROM mfa_recovery_codes WHERE user_id=?", [userId]);
  for (const code of codes)
    await client.query("INSERT INTO mfa_recovery_codes(user_id,code_hash) VALUES(?,?)", [
      userId,
      tokenHash(code),
    ]);
  return codes;
}
