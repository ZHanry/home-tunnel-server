import {
  createHash,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { z } from "zod";
import { config } from "./config.js";
import { type DatabaseClient } from "./db.js";
import { deviceSessionLive } from "./account-session.js";
import { homedeskConfig } from "./homedesk.js";
import { HttpError } from "./http.js";
import type { AuthenticatedActor } from "./types.js";

const seed = Buffer.from(
  hkdfSync(
    "sha256",
    Buffer.from(config.leaseSigningKey),
    "NestLink api-v2",
    "native-p2p-permit",
    32,
  ),
);
const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
  format: "der",
  type: "pkcs8",
});
const publicKey = createPublicKey(privateKey);
const rawPublicKey = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
export const permitTrust = Object.freeze({
  algorithm: "Ed25519",
  public_key: rawPublicKey.toString("base64"),
  realm: createHash("sha256")
    .update(rawPublicKey)
    .update(homedeskConfig.server)
    .update(homedeskConfig.key_sha256)
    .digest("hex"),
  permit_seconds: 45,
  heartbeat_seconds: 5,
  peer_timeout_seconds: 20,
});

const keySchema = z.string().regex(/^[A-Za-z0-9+/]{43}=$/);
const claimsSchema = z.strictObject({
  v: z.literal(2),
  typ: z.literal("NestLink-P2P"),
  jti: z.uuid(),
  realm: z.string().regex(/^[a-f0-9]{64}$/),
  iat: z.int().nonnegative(),
  exp: z.int().nonnegative(),
  controller_device: z.uuid(),
  host_device: z.uuid(),
  controller_session: z.uuid(),
  host_session: z.uuid(),
  controller_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  host_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  controller_key: keySchema,
  host_key: keySchema,
  policy: z.literal("require_direct"),
});
export type PermitClaims = z.infer<typeof claimsSchema>;

export function publicKeyFromBase64(value: string) {
  if (!keySchema.safeParse(value).success)
    throw new HttpError(400, "REMOTE_KEY_INVALID", "设备公钥无效");
  return createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(value, "base64"),
    ]),
    format: "der",
    type: "spki",
  });
}

export function verifyBindingProof(
  deviceId: string,
  remoteId: string,
  key: string,
  proof: string,
): boolean {
  if (!/^[A-Za-z0-9+/]{86}==$/.test(proof)) return false;
  return verify(
    null,
    Buffer.from(`NestLink-binding-v2:${permitTrust.realm}:${deviceId}:${remoteId}`),
    publicKeyFromBase64(key),
    Buffer.from(proof, "base64"),
  );
}

export function signPermit(claims: PermitClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const input = `nlp2.${payload}`;
  return `${input}.${sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
}

export function verifyPermit(value: string, now = Math.floor(Date.now() / 1000)): PermitClaims {
  if (value.length > 4096 || !/^nlp2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/.test(value))
    throw new HttpError(403, "REMOTE_PERMIT_INVALID", "远控许可无效");
  const [prefix, payload, signature] = value.split(".");
  if (
    !verify(
      null,
      Buffer.from(`${prefix}.${payload}`),
      publicKey,
      Buffer.from(signature!, "base64url"),
    )
  )
    throw new HttpError(403, "REMOTE_PERMIT_INVALID", "远控许可签名无效");
  let claims: PermitClaims;
  try {
    claims = claimsSchema.parse(JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")));
  } catch {
    throw new HttpError(403, "REMOTE_PERMIT_INVALID", "远控许可内容无效");
  }
  if (
    claims.realm !== permitTrust.realm ||
    claims.exp <= now ||
    claims.iat > now + 5 ||
    claims.exp - claims.iat !== permitTrust.permit_seconds
  )
    throw new HttpError(403, "REMOTE_PERMIT_EXPIRED", "远控许可已过期或属于其他服务");
  return claims;
}

type RemoteSide = {
  session_id: string;
  device_id: string;
  user_id: string;
  remote_id: string;
  remote_public_key: string;
};

async function remoteSide(
  client: DatabaseClient,
  condition: string,
  values: unknown[],
): Promise<RemoteSide | null> {
  return (
    (
      await client.query<RemoteSide>(
        `SELECT s.id AS session_id,d.id AS device_id,d.user_id,b.remote_id,b.remote_public_key
    FROM sessions s JOIN users u ON u.id=s.user_id
    JOIN devices d ON d.id=s.device_id JOIN homedesk_bindings b ON b.device_id=d.id
    WHERE ${condition} AND s.client_type='device' AND d.credential_purpose='gui'
    AND s.revoked_at IS NULL AND s.refresh_expires_at>home_tunnel_now()
    AND s.token_version=u.token_version AND u.status='active' AND u.password_state='normal'
    AND ${deviceSessionLive} AND b.server=? AND b.key_sha256=?
    AND b.remote_public_key<>'' AND b.last_seen>? ORDER BY s.created_at DESC LIMIT 1`,
        [
          ...values,
          homedeskConfig.server,
          homedeskConfig.key_sha256,
          new Date(Date.now() - 90_000),
        ],
      )
    ).rows[0] ?? null
  );
}

export async function issueRemotePermit(
  client: DatabaseClient,
  actor: AuthenticatedActor,
  targetId: string,
) {
  if (!actor.deviceId)
    throw new HttpError(403, "DEVICE_SESSION_REQUIRED", "请使用已登录的 GUI 设备");
  const controller = await remoteSide(client, "s.id=? AND s.device_id=?", [
    actor.sessionId,
    actor.deviceId,
  ]);
  const host = await remoteSide(client, "b.remote_id=?", [targetId]);
  if (!controller || !host || controller.device_id === host.device_id)
    throw new HttpError(404, "REMOTE_UNAVAILABLE", "设备未登录、未就绪或不可连接");
  const count = (
    await client.query<{ count: number }>(
      "SELECT count(*) AS count FROM native_remote_permits WHERE controller_session_id=? AND state IN ('pending','active') AND expires_at>home_tunnel_now()",
      [actor.sessionId],
    )
  ).rows[0];
  if (Number(count?.count ?? 0) >= 32)
    throw new HttpError(429, "RESOURCE_LIMIT", "同时发起的远控连接过多");
  const now = Math.floor(Date.now() / 1000);
  const claims: PermitClaims = {
    v: 2,
    typ: "NestLink-P2P",
    jti: randomUUID(),
    realm: permitTrust.realm,
    iat: now,
    exp: now + permitTrust.permit_seconds,
    controller_device: controller.device_id,
    host_device: host.device_id,
    controller_session: controller.session_id,
    host_session: host.session_id,
    controller_id: controller.remote_id,
    host_id: host.remote_id,
    controller_key: controller.remote_public_key,
    host_key: host.remote_public_key,
    policy: "require_direct",
  };
  await client.query(
    `INSERT INTO native_remote_permits(id,controller_session_id,host_session_id,controller_device_id,host_device_id,claims_json,controller_seen_at,host_seen_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?,?)`,
    [
      claims.jti,
      controller.session_id,
      host.session_id,
      controller.device_id,
      host.device_id,
      JSON.stringify(claims),
      new Date(),
      new Date(),
      new Date(claims.exp * 1000),
    ],
  );
  return {
    permit_id: claims.jti,
    permit: signPermit(claims),
    expires_at: new Date(claims.exp * 1000).toISOString(),
    policy: "require_direct",
  };
}

export async function requireLivePermit(
  client: DatabaseClient,
  actor: AuthenticatedActor,
  id: string,
) {
  const row = (
    await client.query<{
      id: string;
      controller_session_id: string;
      host_session_id: string;
      state: string;
      claims_json: PermitClaims;
      peer_connection_id: string | null;
      expires_at: Date;
      controller_seen_at: Date;
      host_seen_at: Date;
    }>(
      "SELECT * FROM native_remote_permits WHERE id=? AND (controller_session_id=? OR host_session_id=?)",
      [id, actor.sessionId, actor.sessionId],
    )
  ).rows[0];
  if (!row) throw new HttpError(404, "REMOTE_PERMIT_UNKNOWN", "远控许可不存在");
  if (!["pending", "active"].includes(row.state) || row.expires_at.getTime() <= Date.now())
    throw new HttpError(403, "REMOTE_PERMIT_REVOKED", "远控许可已结束");
  const controller = await remoteSide(client, "s.id=?", [row.controller_session_id]);
  const host = await remoteSide(client, "s.id=?", [row.host_session_id]);
  if (
    !controller ||
    !host ||
    controller.remote_public_key !== row.claims_json.controller_key ||
    host.remote_public_key !== row.claims_json.host_key ||
    controller.remote_id !== row.claims_json.controller_id ||
    host.remote_id !== row.claims_json.host_id
  )
    throw new HttpError(403, "REMOTE_PERMIT_REVOKED", "相关账号或设备登录已失效");
  return row;
}
