import { createHash } from "node:crypto";
import { isIP } from "node:net";

// The public hbbs key is a trust anchor, never its private key or relay address.
export function normalizeIdServer(value: string): string | null {
  const match = /^([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(value.trim());
  if (!match) return null;
  const host = match[1]!.toLowerCase(),
    port = Number(match[2] ?? 21116);
  if (port < 1 || port > 65535 || host.length > 253) return null;
  if (/^[0-9.]+$/.test(host) && isIP(host) !== 4) return null;
  if (
    isIP(host) !== 4 &&
    (!host.includes(".") ||
      !host.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)))
  )
    return null;
  return `${host}:${port}`;
}

const configuredServer = process.env.HOMEDESK_ID_SERVER?.trim() ?? "";
const publicKey = process.env.HOMEDESK_HBBS_PUBLIC_KEY?.trim() ?? "";
if (configuredServer && !normalizeIdServer(configuredServer)) {
  throw new Error("HOMEDESK_ID_SERVER must be an IPv4 address or hostname with an optional port");
}
if (
  publicKey &&
  (!/^[A-Za-z0-9+/]{43}=$/.test(publicKey) || Buffer.from(publicKey, "base64").length !== 32)
) {
  throw new Error("HOMEDESK_HBBS_PUBLIC_KEY must be the 32-byte Base64 hbbs public key");
}
if (Boolean(configuredServer) !== Boolean(publicKey)) {
  throw new Error("Configure HOMEDESK_ID_SERVER and HOMEDESK_HBBS_PUBLIC_KEY together");
}
export const homedeskConfig = {
  configured: Boolean(configuredServer && publicKey),
  server: normalizeIdServer(configuredServer) ?? "",
  key: publicKey,
  // HomeDesk fingerprints trimmed Base64 TEXT, not the decoded key bytes.
  key_sha256: publicKey ? createHash("sha256").update(publicKey).digest("hex") : "",
  policy: "require_direct",
  relay_enabled: false,
} as const;
