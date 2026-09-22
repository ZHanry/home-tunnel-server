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
  enabled: flag("RD_ENABLED", false),
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
};
if (flag("RD_ALLOW_TURN", false) || flag("RD_ALLOW_ICE_TCP", false) || !flag("RD_UDP_ONLY", true))
  throw new Error("RD requires UDP direct paths; relay and ICE-TCP are forbidden");
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
export function loadSigningKey() {
  if (!rdConfig.signingKeyFile)
    throw new Error("RD_SIGNING_KEY_FILE is required when RD is enabled");
  const key = createPrivateKey(readFileSync(rdConfig.signingKeyFile));
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
    throw new Error("RD signing key must be P-256");
  return key;
}
