import type { Request } from "express";
import { config } from "../config.js";
import { HttpError } from "../http.js";
import { digest, publicJwk, verifyJws } from "./crypto.js";
import { tokenIdentity, type RdIdentity } from "./service.js";

const replay = new Map<string, number>();
export async function authenticateRd(request: Request): Promise<RdIdentity> {
  const authorization = request.header("authorization") ?? "";
  if (!/^DPoP [A-Za-z0-9_-]{43}$/.test(authorization))
    throw new HttpError(401, "RD_AUTH_REQUIRED", "需要 DPoP 远程桌面凭据");
  const token = authorization.slice(5),
    identity = await tokenIdentity(token);
  const proof = verifyJws(
    request.header("dpop") ?? "",
    publicJwk(JSON.parse(identity.endpoint.public_jwk)),
    "dpop+jwt",
  );
  const now = Math.floor(Date.now() / 1000);
  const uri = new URL(request.originalUrl.split("?")[0]!, config.publicBaseUrl).href;
  if (
    Object.keys(proof).some((k) => !["jti", "htm", "htu", "iat", "ath", "nonce"].includes(k)) ||
    proof.htm !== request.method ||
    proof.htu !== uri ||
    proof.ath !== digest(token) ||
    proof.nonce !== identity.nonce ||
    typeof proof.jti !== "string" ||
    proof.jti.length < 16 ||
    proof.jti.length > 128 ||
    !Number.isSafeInteger(proof.iat) ||
    Math.abs(now - Number(proof.iat)) > 60
  )
    throw new HttpError(401, "RD_PROOF_INVALID", "DPoP 证明无效或过期");
  const replayKey = `${identity.endpoint.jkt}:${proof.jti}`;
  for (const [key, expires] of replay) if (expires < now) replay.delete(key);
  if (replay.has(replayKey)) throw new HttpError(401, "RD_PROOF_REPLAY", "DPoP 证明已使用");
  if (replay.size >= 10000) throw new HttpError(429, "RD_RATE_LIMITED", "证明验证队列已满");
  replay.set(replayKey, now + 120);
  return identity;
}
