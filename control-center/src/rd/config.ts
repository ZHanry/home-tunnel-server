import { readFileSync } from "node:fs";
import { createPrivateKey } from "node:crypto";
import { isIP } from "node:net";

const knownOptions = new Set([
  "RD_ENABLED",
  "RD_SIGNING_KEY_FILE",
  "RD_KEYSET_FILE",
  "RD_STUN_URLS",
  "RD_MAX_ENDPOINTS_PER_USER",
  "RD_MAX_SESSIONS_PER_USER",
  "RD_MAX_SESSIONS_PER_CONTROLLER",
  "RD_MAX_SESSIONS_PER_HOST",
  "RD_ALLOW_TURN",
  "RD_ALLOW_ICE_TCP",
  "RD_UDP_ONLY",
  "RD_TURN_URLS",
  "RD_TURN_SECRET_FILE",
  "RD_TURN_TTL_SECONDS",
]);
for (const name of Object.keys(process.env))
  if (name.startsWith("RD_") && !knownOptions.has(name))
    throw new Error(`Unknown remote desktop option ${name}`);

function number(name: string, fallback: number, maximum: number) {
  const text = process.env[name];
  if (text === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(text) || Number(text) > maximum) throw new Error(`Invalid ${name}`);
  return Number(text);
}
function flag(name: string, fallback: boolean) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`Invalid ${name}`);
}
export const rdConfig = {
  // 11.x retires the browser/WebRTC engine. Its historical contract tests remain runnable.
  enabled: process.env.NODE_ENV === "test" && flag("RD_ENABLED", false),
  signingKeyFile: process.env.RD_SIGNING_KEY_FILE ?? "",
  keysetFile: process.env.RD_KEYSET_FILE ?? "",
  stunUrls: (process.env.RD_STUN_URLS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean),
  endpointsPerUser: number("RD_MAX_ENDPOINTS_PER_USER", 8, 100),
  sessionsPerUser: number("RD_MAX_SESSIONS_PER_USER", 4, 32),
  sessionsPerController: number("RD_MAX_SESSIONS_PER_CONTROLLER", 4, 16),
  sessionsPerHost: number("RD_MAX_SESSIONS_PER_HOST", 1, 1),
  leaseSeconds: 900,
  tokenSeconds: 600,
  maxConnections: 100,
  maxUnauthenticated: 32,
  messageBytes: 65536,
  queueBytes: 262144,
  businessBytesPerDay: 20971520,
  reservedBytesPerDay: 8388608,
  // UDP TURN relay is a fallback for peers that cannot punch a direct path.
  // Media stays DTLS-SRTP end to end; the relay only forwards ciphertext.
  turnUrls: (process.env.RD_TURN_URLS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean),
  turnSecretFile: process.env.RD_TURN_SECRET_FILE ?? "",
  turnTtlSeconds: number("RD_TURN_TTL_SECONDS", 43200, 86400),
};
if (flag("RD_ALLOW_TURN", false) || flag("RD_ALLOW_ICE_TCP", false) || !flag("RD_UDP_ONLY", true))
  throw new Error("RD requires UDP paths; legacy relay and ICE-TCP flags are forbidden");
if (
  rdConfig.stunUrls.length > 4 ||
  rdConfig.stunUrls.some((value) => {
    const match = /^stun:([a-z0-9.-]+|\[[0-9a-f:]+\]):([0-9]{1,5})$/i.exec(value);
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) return true;
    if (match[1]!.startsWith("[")) return isIP(match[1]!.slice(1, -1)) !== 6;
    return match[1]!
      .split(".")
      .some((label) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label) || label.length > 63);
  })
)
  throw new Error("RD_STUN_URLS accepts at most four explicit stun:host:port URLs");
if (
  rdConfig.turnUrls.length > 4 ||
  rdConfig.turnUrls.some((value) => {
    const match = /^turn:([a-z0-9.-]+|\[[0-9a-f:]+\]):([0-9]{1,5})\?transport=udp$/i.exec(value);
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) return true;
    if (match[1]!.startsWith("[")) return isIP(match[1]!.slice(1, -1)) !== 6;
    return match[1]!
      .split(".")
      .some((label) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label) || label.length > 63);
  })
)
  throw new Error("RD_TURN_URLS accepts at most four turn:host:port?transport=udp URLs");
if (rdConfig.turnUrls.length && !rdConfig.turnSecretFile)
  throw new Error("RD_TURN_SECRET_FILE is required when RD_TURN_URLS is set");
let turnSecret: Buffer | undefined;
export function relayEnabled() {
  return rdConfig.enabled && rdConfig.turnUrls.length > 0;
}
export function loadTurnSecret() {
  if (!relayEnabled()) return undefined;
  if (!turnSecret) {
    const value = readFileSync(rdConfig.turnSecretFile, "utf8").trim();
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(value))
      throw new Error("RD TURN secret must be 32+ url-safe characters");
    turnSecret = Buffer.from(value, "utf8");
  }
  return turnSecret;
}
export function loadSigningKey() {
  if (!rdConfig.signingKeyFile)
    throw new Error("RD_SIGNING_KEY_FILE is required when RD is enabled");
  const key = createPrivateKey(readFileSync(rdConfig.signingKeyFile));
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
    throw new Error("RD signing key must be P-256");
  return key;
}
