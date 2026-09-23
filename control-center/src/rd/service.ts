import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { config } from "../config.js";
import { one, query, transaction, type DatabaseClient, type DatabaseRow } from "../db.js";
import { HttpError } from "../http.js";
import { tokenHash } from "../security.js";
import type { AuthenticatedActor } from "../types.js";
import { rdConfig } from "./config.js";
import { genesisKeyset, parseManifest, verifyKeysetUpdate } from "./keyset.js";
import {
  canonical,
  digest,
  publicJwk,
  serverPublicKey,
  signer,
  signJws,
  thumbprint,
  verifyJws,
  type PublicJwk,
} from "./crypto.js";

export const permissions = [
  "view",
  "input.keyboard",
  "input.pointer",
  "input.text",
  "audio.system",
  "audio.microphone",
  "clipboard.read",
  "clipboard.write",
  "files.send",
  "files.receive",
] as const;
export type Permission = (typeof permissions)[number];
export type Endpoint = DatabaseRow & {
  id: string;
  owner_user_id: string;
  linked_device_id: string | null;
  kind: string;
  role: string;
  name: string;
  platform: string;
  public_jwk: string;
  jkt: string;
  status: string;
  local_enabled: number;
  capability_json: string;
  capability_version: number;
  metadata_version: number;
};
export type RdIdentity = {
  endpoint: Endpoint;
  tokenId: string;
  purpose: string;
  parentSessionId: string | null;
  tokenVersion: number;
  expiresAt: number;
  nonce: string;
};
export type Session = DatabaseRow & {
  id: string;
  session_request_id: string;
  owner_user_id: string;
  host_endpoint_id: string;
  controller_endpoint_id: string;
  controller_parent_session_id: string | null;
  user_token_version: number;
  grant_id: string;
  grant_version: number;
  permissions_json: string;
  state: string;
  state_version: number;
  connection_epoch: number;
  network_reconnect_count: number;
  display_id: string;
  ticket_jti: string | null;
  ticket_jws: string | null;
  lease_seq: number;
  lease_jws: string | null;
  lease_expires_at: Date | null;
  approval_expires_at: Date;
  restore_epoch: number;
  host_ready: number;
  controller_ready: number;
};
type Grant = DatabaseRow & {
  id: string;
  owner_user_id: string;
  host_endpoint_id: string;
  controller_endpoint_id: string;
  host_jkt: string;
  controller_jkt: string;
  scope_json: string;
  mode: string;
  one_session_request_id: string | null;
  grant_version: number;
  host_signature: string;
  status: string;
  expires_at: Date | null;
};
export const rdEvents = new EventEmitter();
export const rdOnlineEndpoints = new Set<string>();
export const nowIso = () => new Date().toISOString();
export const afterSeconds = (seconds: number) =>
  new Date(Date.now() + seconds * 1000).toISOString();
export const timestamp = (value: unknown) =>
  value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : 0;
const terminal = ["closed", "expired", "failed"];
export function fail(status: number, code: string, message: string): never {
  throw new HttpError(status, code, message);
}
async function first<T extends DatabaseRow>(
  db: DatabaseClient,
  sql: string,
  args: unknown[] = [],
): Promise<T | null> {
  return (await db.query<T>(sql, args)).rows[0] ?? null;
}
export async function initializeRd() {
  if (rdConfig.enabled) signer();
  await query("INSERT OR IGNORE INTO rd_server_state(id,server_instance_id) VALUES(1,?)", [
    randomUUID(),
  ]);
  if (rdConfig.enabled)
    await transaction(async (db) => {
      const state = await first<{
        server_instance_id: string;
        keyset_version: number;
        keyset_json: string | null;
      }>(
        db,
        "SELECT server_instance_id,keyset_version,keyset_json FROM rd_server_state WHERE id=1",
      );
      if (!state) throw new Error("Missing RD server state");
      const trusted = state.keyset_json
        ? parseManifest(state.keyset_json)
        : genesisKeyset(state.server_instance_id, serverPublicKey());
      if (
        trusted.server_instance_id !== state.server_instance_id ||
        trusted.keyset_version !== state.keyset_version
      )
        throw new Error("RD persisted keyset identity/version mismatch");
      const proposed = rdConfig.keysetFile
        ? parseManifest(readFileSync(rdConfig.keysetFile, "utf8"))
        : trusted;
      const verified = verifyKeysetUpdate(trusted, proposed);
      if (
        verified.active_kid !== thumbprint(serverPublicKey()) ||
        verified.keyset_version < state.keyset_version
      )
        throw new Error("RD signing key does not match the trusted active keyset");
      await db.query("UPDATE rd_server_state SET keyset_version=?,keyset_json=? WHERE id=1", [
        verified.keyset_version,
        JSON.stringify(verified),
      ]);
    });
}
export async function serverState(db?: DatabaseClient) {
  const sql =
    "SELECT server_instance_id,restore_epoch,keyset_version FROM rd_server_state WHERE id=1";
  const state = db
    ? await first<{ server_instance_id: string; restore_epoch: number; keyset_version: number }>(
        db,
        sql,
      )
    : await one<{ server_instance_id: string; restore_epoch: number; keyset_version: number }>(sql);
  if (!state) fail(503, "RD_UNAVAILABLE", "远程桌面尚未初始化");
  return state;
}
export async function requireEnabled() {
  if (!rdConfig.enabled) fail(503, "RD_DISABLED", "服务器未启用远程桌面");
  const row = await one<{ policy_json: string }>(
    "SELECT policy_json FROM rd_policy WHERE scope_type='global' AND scope_id='global'",
  );
  if (row && (JSON.parse(row.policy_json) as { enabled?: boolean }).enabled === false)
    fail(503, "RD_DISABLED", "管理员已关闭远程桌面");
}
export async function keySet() {
  const state = await serverState();
  const row = await one<{ keyset_json: string | null }>(
    "SELECT keyset_json FROM rd_server_state WHERE id=1",
  );
  if (!row?.keyset_json) fail(503, "RD_UNAVAILABLE", "远程桌面公钥尚未初始化");
  return {
    ...state,
    ...parseManifest(row.keyset_json),
  };
}
export function endpointView(endpoint: Endpoint) {
  return {
    id: endpoint.id,
    owner_user_id: endpoint.owner_user_id,
    linked_device_id: endpoint.linked_device_id,
    endpoint_kind: endpoint.kind,
    role: endpoint.role,
    name: endpoint.name,
    platform: endpoint.platform,
    public_jwk: JSON.parse(endpoint.public_jwk) as PublicJwk,
    jkt: endpoint.jkt,
    status: endpoint.status,
    local_enabled: Boolean(endpoint.local_enabled),
    online: rdOnlineEndpoints.has(endpoint.id),
    capabilities: JSON.parse(endpoint.capability_json) as unknown,
    capability_version: endpoint.capability_version,
    metadata_version: endpoint.metadata_version,
  };
}
export async function audit(db: DatabaseClient, owner: string, action: string, id: string) {
  await db.query(
    "INSERT INTO rd_audit(id,owner_user_id,action,resource_id,created_at) VALUES(?,?,?,?,?)",
    [randomUUID(), owner, action, id, nowIso()],
  );
}
export async function accountSignalBytes(
  owner: string,
  incoming: number,
  outgoing: number,
  reserved = false,
  existing?: DatabaseClient,
) {
  const charge = async (db: DatabaseClient) => {
    const date = nowIso().slice(0, 10);
    await db.query("INSERT OR IGNORE INTO rd_usage_daily(owner_user_id,date_utc) VALUES(?,?)", [
      owner,
      date,
    ]);
    const row = await first<{
      business_in_bytes: number;
      business_out_bytes: number;
      reserved_bytes: number;
    }>(
      db,
      "SELECT business_in_bytes,business_out_bytes,reserved_bytes FROM rd_usage_daily WHERE owner_user_id=? AND date_utc=?",
      [owner, date],
    );
    const bytes = incoming + outgoing;
    if (
      !row ||
      (reserved
        ? row.reserved_bytes + bytes > rdConfig.reservedBytesPerDay
        : row.business_in_bytes + row.business_out_bytes + bytes >= rdConfig.businessBytesPerDay)
    )
      fail(429, "RD_SIGNAL_BUDGET", "今日信令预算已用尽");
    await db.query(
      reserved
        ? "UPDATE rd_usage_daily SET reserved_bytes=reserved_bytes+? WHERE owner_user_id=? AND date_utc=?"
        : "UPDATE rd_usage_daily SET business_in_bytes=business_in_bytes+?,business_out_bytes=business_out_bytes+? WHERE owner_user_id=? AND date_utc=?",
      reserved ? [bytes, owner, date] : [incoming, outgoing, owner, date],
    );
  };
  if (existing) await charge(existing);
  else await transaction(charge);
}
export async function recentAccount(actor: AuthenticatedActor, db?: DatabaseClient) {
  if (actor.deviceId || actor.passwordState !== "normal")
    fail(403, "RD_ACCOUNT_REQUIRED", "请使用账号管理会话");
  const sql =
    "SELECT rd_verified_at FROM sessions WHERE id=? AND revoked_at IS NULL AND token_version=? AND access_expires_at>home_tunnel_now()";
  const row = db
    ? await first(db, sql, [actor.sessionId, actor.tokenVersion])
    : await one(sql, [actor.sessionId, actor.tokenVersion]);
  if (!row || Date.now() - timestamp(row.rd_verified_at) > 300000)
    fail(401, "RD_RECENT_AUTH_REQUIRED", "请重新验证账号");
}
export async function endpointById(
  db: DatabaseClient,
  id: string,
  owner?: string,
): Promise<Endpoint> {
  const row = await first<Endpoint>(
    db,
    "SELECT * FROM rd_endpoints WHERE id=?" + (owner ? " AND owner_user_id=?" : ""),
    owner ? [id, owner] : [id],
  );
  if (!row) fail(404, "RD_NOT_FOUND", "远程桌面端点不存在");
  return row;
}
async function issueToken(
  db: DatabaseClient,
  endpoint: Endpoint,
  purpose: string,
  parent: string | null,
  version: number,
) {
  const token = randomBytes(32).toString("base64url"),
    nonce = randomBytes(32).toString("base64url"),
    expires = afterSeconds(rdConfig.tokenSeconds);
  await db.query(
    "INSERT INTO rd_tokens(id,token_hash,endpoint_id,owner_user_id,purpose,parent_session_id,parent_token_version,jkt,nonce,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    [
      randomUUID(),
      tokenHash(token),
      endpoint.id,
      endpoint.owner_user_id,
      purpose,
      parent,
      version,
      endpoint.jkt,
      nonce,
      expires,
      nowIso(),
    ],
  );
  return { token, expires_at: expires, dpop_nonce: nonce };
}
async function boundedChallenges(db: DatabaseClient) {
  await db.query("DELETE FROM rd_challenges WHERE expires_at<=home_tunnel_now()");
  const row = await first<{ count: number }>(db, "SELECT count(*) AS count FROM rd_challenges");
  if (Number(row?.count) >= 10000) fail(429, "RD_RATE_LIMITED", "挑战配额已满");
}
export async function enrollmentChallenge(
  actor: AuthenticatedActor,
  body: { endpoint_kind: string; role: string; public_jwk: PublicJwk; linked_device_id?: string },
) {
  return transaction(async (db) => {
    await recentAccount(actor, db);
    await boundedChallenges(db);
    if (body.endpoint_kind !== "desktop" && body.role !== "controller")
      fail(422, "RD_ROLE_INVALID", "移动端和浏览器只能作为控制端");
    if (body.role !== "controller" && !body.linked_device_id)
      fail(422, "RD_DEVICE_REQUIRED", "被控端必须关联本机设备");
    if (
      body.linked_device_id &&
      !(await first(
        db,
        "SELECT id FROM devices WHERE id=? AND user_id=? AND status='active' AND revoked_at IS NULL",
        [body.linked_device_id, actor.userId],
      ))
    )
      fail(404, "RD_NOT_FOUND", "本机设备不存在");
    const count = await first<{ count: number }>(
      db,
      "SELECT count(*) AS count FROM rd_endpoints WHERE owner_user_id=? AND status='active'",
      [actor.userId],
    );
    if (Number(count?.count) >= rdConfig.endpointsPerUser)
      fail(429, "RD_ENDPOINT_LIMIT", "远程桌面端点数量已达上限");
    const challenge_id = randomUUID(),
      nonce = randomBytes(32).toString("base64url"),
      expires_at = afterSeconds(30);
    const proof_payload = {
      purpose: "enrollment",
      challenge_id,
      nonce,
      server_instance_id: (await serverState(db)).server_instance_id,
      endpoint_kind: body.endpoint_kind,
      role: body.role,
      public_jwk: publicJwk(body.public_jwk),
      linked_device_id: body.linked_device_id ?? null,
      issued_at: nowIso(),
    };
    await db.query(
      "INSERT INTO rd_challenges(id,owner_user_id,purpose,context_json,parent_session_id,expires_at) VALUES(?,?,'enrollment',?,?,?)",
      [challenge_id, actor.userId, JSON.stringify(proof_payload), actor.sessionId, expires_at],
    );
    return { challenge_id, nonce, expires_at, proof_payload };
  });
}
async function consumeChallenge(db: DatabaseClient, id: string, purpose?: string) {
  const row = await first<{
    id: string;
    endpoint_id: string | null;
    owner_user_id: string | null;
    purpose: string;
    context_json: string;
    parent_session_id: string | null;
  }>(
    db,
    "SELECT * FROM rd_challenges WHERE id=? AND consumed_at IS NULL AND expires_at>home_tunnel_now()",
    [id],
  );
  if (!row || (purpose && row.purpose !== purpose))
    fail(401, "RD_CHALLENGE_INVALID", "挑战无效或已过期");
  await db.query("UPDATE rd_challenges SET consumed_at=home_tunnel_now() WHERE id=?", [id]);
  return row;
}
export async function enroll(
  actor: AuthenticatedActor,
  body: { challenge_id: string; signed_proof: string; name: string; platform: string },
) {
  return transaction(async (db) => {
    await recentAccount(actor, db);
    const challenge = await consumeChallenge(db, body.challenge_id, "enrollment");
    if (challenge.owner_user_id !== actor.userId || challenge.parent_session_id !== actor.sessionId)
      fail(401, "RD_CHALLENGE_INVALID", "挑战不属于当前会话");
    const context = JSON.parse(challenge.context_json) as Record<string, unknown>;
    const key = publicJwk(context.public_jwk),
      proof = verifyJws(body.signed_proof, key, "ht-rd-proof+jwt");
    if (canonical(proof) !== canonical(context))
      fail(401, "RD_PROOF_INVALID", "挑战签名内容不匹配");
    const count = await first<{ count: number }>(
      db,
      "SELECT count(*) AS count FROM rd_endpoints WHERE owner_user_id=? AND status='active'",
      [actor.userId],
    );
    if (Number(count?.count) >= rdConfig.endpointsPerUser)
      fail(429, "RD_ENDPOINT_LIMIT", "远程桌面端点数量已达上限");
    if (await first(db, "SELECT id FROM rd_endpoints WHERE jkt=?", [thumbprint(key)]))
      fail(409, "RD_KEY_REGISTERED", "该密钥已登记；请刷新身份或重新配对");
    if (
      context.linked_device_id &&
      !(await first(
        db,
        "SELECT id FROM devices WHERE id=? AND user_id=? AND status='active' AND revoked_at IS NULL",
        [context.linked_device_id, actor.userId],
      ))
    )
      fail(404, "RD_NOT_FOUND", "本机设备不存在");
    const id = randomUUID(),
      now = nowIso();
    await db.query(
      "INSERT INTO rd_endpoints(id,owner_user_id,linked_device_id,kind,role,name,platform,public_jwk,jkt,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      [
        id,
        actor.userId,
        context.linked_device_id,
        context.endpoint_kind,
        context.role,
        body.name,
        body.platform,
        JSON.stringify(key),
        thumbprint(key),
        now,
        now,
      ],
    );
    const endpoint = await endpointById(db, id);
    await audit(db, actor.userId, "EndpointEnrolled", id);
    return {
      endpoint: endpointView(endpoint),
      ...(await issueToken(
        db,
        endpoint,
        endpoint.role === "host" ? "host_online" : "controller_refresh",
        endpoint.role === "host" ? null : actor.sessionId,
        actor.tokenVersion,
      )),
    };
  });
}
export async function tokenChallenge(
  endpointId: string,
  purpose: string,
  actor?: AuthenticatedActor,
) {
  return transaction(async (db) => {
    await boundedChallenges(db);
    // All syntactically valid IDs receive indistinguishable challenge envelopes.
    const endpoint = await first<Endpoint>(
      db,
      "SELECT * FROM rd_endpoints WHERE id=? AND status='active'",
      [endpointId],
    );
    const valid =
      endpoint &&
      (purpose === "host_online"
        ? endpoint.role !== "controller"
        : actor &&
          !actor.deviceId &&
          actor.userId === endpoint.owner_user_id &&
          endpoint.role !== "host");
    const challenge_id = randomUUID(),
      nonce = randomBytes(32).toString("base64url"),
      expires_at = afterSeconds(30);
    const proof_payload = {
      purpose,
      challenge_id,
      nonce,
      server_instance_id: (await serverState(db)).server_instance_id,
      endpoint_id: endpointId,
      issued_at: nowIso(),
    };
    await db.query(
      "INSERT INTO rd_challenges(id,endpoint_id,owner_user_id,purpose,context_json,parent_session_id,expires_at) VALUES(?,?,?,?,?,?,?)",
      [
        challenge_id,
        valid ? endpoint.id : null,
        valid ? endpoint.owner_user_id : null,
        purpose,
        JSON.stringify(proof_payload),
        valid && purpose === "controller_refresh" ? actor!.sessionId : null,
        expires_at,
      ],
    );
    return { challenge_id, nonce, expires_at, proof_payload };
  });
}
export async function refreshToken(
  body: { endpoint_id: string; challenge_id: string; proof: string },
  actor?: AuthenticatedActor,
) {
  return transaction(async (db) => {
    const challenge = await consumeChallenge(db, body.challenge_id);
    if (
      challenge.endpoint_id !== body.endpoint_id ||
      !["host_online", "controller_refresh"].includes(challenge.purpose)
    )
      fail(401, "RD_CHALLENGE_INVALID", "挑战无效");
    const endpoint = await endpointById(db, body.endpoint_id),
      key = publicJwk(JSON.parse(endpoint.public_jwk));
    if (
      canonical(verifyJws(body.proof, key, "ht-rd-proof+jwt")) !==
      canonical(JSON.parse(challenge.context_json))
    )
      fail(401, "RD_PROOF_INVALID", "挑战签名内容不匹配");
    const user = await first<{ token_version: number; status: string }>(
      db,
      "SELECT token_version,status FROM users WHERE id=?",
      [endpoint.owner_user_id],
    );
    if (!user || user.status !== "active" || endpoint.status !== "active")
      fail(401, "RD_AUTH_REVOKED", "远程桌面身份已撤销");
    if (
      challenge.purpose === "controller_refresh" &&
      (!actor ||
        actor.deviceId ||
        actor.userId !== endpoint.owner_user_id ||
        actor.sessionId !== challenge.parent_session_id ||
        actor.tokenVersion !== user.token_version)
    )
      fail(401, "RD_ACCOUNT_REQUIRED", "控制端需要有效父账号会话");
    return issueToken(
      db,
      endpoint,
      challenge.purpose,
      challenge.parent_session_id,
      user.token_version,
    );
  });
}
export async function tokenIdentity(token: string): Promise<RdIdentity> {
  if (!token || token.length > 1024) fail(401, "RD_AUTH_REQUIRED", "需要远程桌面凭据");
  const row = await one<{
    id: string;
    endpoint_id: string;
    purpose: string;
    parent_session_id: string | null;
    parent_token_version: number;
    expires_at: Date;
    nonce: string;
  }>(
    `SELECT t.* FROM rd_tokens t JOIN rd_endpoints e ON e.id=t.endpoint_id JOIN users u ON u.id=t.owner_user_id WHERE t.token_hash=? AND t.revoked_at IS NULL AND t.expires_at>home_tunnel_now() AND e.status='active' AND u.status='active' AND u.token_version=t.parent_token_version AND (t.purpose='host_online' OR EXISTS(SELECT 1 FROM sessions s WHERE s.id=t.parent_session_id AND s.revoked_at IS NULL AND s.token_version=u.token_version AND s.refresh_expires_at>home_tunnel_now()))`,
    [tokenHash(token)],
  );
  if (!row) fail(401, "RD_AUTH_REVOKED", "远程桌面凭据已失效");
  const endpoint = await one<Endpoint>("SELECT * FROM rd_endpoints WHERE id=?", [row.endpoint_id]);
  if (!endpoint) fail(401, "RD_AUTH_REVOKED", "远程桌面身份已撤销");
  return {
    endpoint,
    tokenId: row.id,
    purpose: row.purpose,
    parentSessionId: row.parent_session_id,
    tokenVersion: row.parent_token_version,
    expiresAt: timestamp(row.expires_at),
    nonce: row.nonce,
  };
}
export function requireController(identity: RdIdentity) {
  if (identity.purpose !== "controller_refresh" || identity.endpoint.role === "host")
    fail(403, "RD_CONTROLLER_REQUIRED", "需要控制端账号身份");
}
export function requireHost(identity: RdIdentity) {
  if (identity.endpoint.role === "controller") fail(403, "RD_HOST_REQUIRED", "需要被控端身份");
}
export async function assertLiveIdentity(db: DatabaseClient, identity: RdIdentity) {
  const valid = await first(
    db,
    `SELECT t.id FROM rd_tokens t JOIN users u ON u.id=t.owner_user_id JOIN rd_endpoints e ON e.id=t.endpoint_id WHERE t.id=? AND t.revoked_at IS NULL AND t.expires_at>home_tunnel_now() AND u.status='active' AND t.parent_token_version=u.token_version AND e.status='active' AND (t.purpose='host_online' OR EXISTS(SELECT 1 FROM sessions s WHERE s.id=t.parent_session_id AND s.revoked_at IS NULL AND s.refresh_expires_at>home_tunnel_now() AND s.token_version=u.token_version))`,
    [identity.tokenId],
  );
  if (!valid) fail(401, "RD_AUTH_REVOKED", "远程桌面身份已撤销");
}
export async function signalTicket(identity: RdIdentity, purpose: string) {
  return transaction(async (db) => {
    await assertLiveIdentity(db, identity);
    await boundedChallenges(db);
    const ticket = randomBytes(32).toString("base64url"),
      expires_at = afterSeconds(30);
    await db.query(
      "INSERT INTO rd_challenges(id,endpoint_id,owner_user_id,purpose,context_json,expires_at) VALUES(?,?,?,'signal',?,?)",
      [
        tokenHash(ticket),
        identity.endpoint.id,
        identity.endpoint.owner_user_id,
        JSON.stringify({ token_id: identity.tokenId, purpose }),
        expires_at,
      ],
    );
    return { ticket, expires_at, signal_path: "/api/v1/rd/signal", subprotocol: "ht.rd.signal.v1" };
  });
}
export async function authenticateSignal(
  ticket: string,
  proof: string,
  connectionId: string,
  nonce: string,
) {
  return transaction(async (db) => {
    const challenge = await consumeChallenge(db, tokenHash(ticket), "signal");
    const context = JSON.parse(challenge.context_json) as { token_id: string };
    const token = await first<{
      id: string;
      purpose: string;
      parent_session_id: string | null;
      parent_token_version: number;
      expires_at: Date;
      nonce: string;
    }>(db, "SELECT * FROM rd_tokens WHERE id=?", [context.token_id]);
    if (!token || !challenge.endpoint_id) fail(401, "RD_AUTH_REVOKED", "信令凭据无效");
    const endpoint = await endpointById(db, challenge.endpoint_id);
    const identity: RdIdentity = {
      endpoint,
      tokenId: token.id,
      purpose: token.purpose,
      parentSessionId: token.parent_session_id,
      tokenVersion: token.parent_token_version,
      expiresAt: timestamp(token.expires_at),
      nonce: token.nonce,
    };
    await assertLiveIdentity(db, identity);
    const payload = verifyJws(
      proof,
      publicJwk(JSON.parse(endpoint.public_jwk)),
      "ht-rd-signal+jwt",
    );
    const expected = {
      connection_id: connectionId,
      nonce,
      ticket_hash: digest(ticket),
      endpoint_id: endpoint.id,
    };
    if (canonical(payload) !== canonical(expected)) fail(401, "RD_PROOF_INVALID", "信令证明无效");
    await db.query("UPDATE rd_endpoints SET presence_generation=presence_generation+1 WHERE id=?", [
      endpoint.id,
    ]);
    const generation = await first<{ presence_generation: number }>(
      db,
      "SELECT presence_generation FROM rd_endpoints WHERE id=?",
      [endpoint.id],
    );
    return { identity, generation: Number(generation?.presence_generation) };
  });
}

export async function cleanupRd(db: DatabaseClient) {
  await db.query(
    "UPDATE rd_grants SET status='expired',updated_at=home_tunnel_now() WHERE status='active' AND expires_at IS NOT NULL AND expires_at<=home_tunnel_now()",
  );
  await db.query(
    "UPDATE rd_sessions SET state='closing',state_version=state_version+1,close_reason='RD_GRANT_EXPIRED',updated_at=home_tunnel_now() WHERE state NOT IN ('closed','failed','expired','closing') AND grant_id IN (SELECT id FROM rd_grants WHERE status='expired')",
  );
  await db.query(
    "UPDATE rd_sessions SET state='closed',state_version=state_version+1,closed_at=home_tunnel_now(),updated_at=home_tunnel_now() WHERE state='closing' AND lease_expires_at IS NULL",
  );
  await db.query(
    "UPDATE rd_sessions SET state='expired',state_version=state_version+1,closed_at=home_tunnel_now(),close_reason=COALESCE(close_reason,'RD_LEASE_EXPIRED') WHERE state NOT IN ('closed','failed','expired') AND ((lease_expires_at IS NOT NULL AND lease_expires_at<=home_tunnel_now()) OR (lease_expires_at IS NULL AND (approval_expires_at<=home_tunnel_now() OR state='closing')))",
  );
  await db.query(
    "DELETE FROM rd_session_slots WHERE session_id IN(SELECT id FROM rd_sessions WHERE state IN ('closed','failed','expired'))",
  );
  await db.query(
    "UPDATE rd_pairings SET state='expired',host_proof=NULL,controller_proof=NULL WHERE state='pending' AND expires_at<=home_tunnel_now()",
  );
  await db.query("DELETE FROM rd_challenges WHERE expires_at<=home_tunnel_now()");
  await db.query("DELETE FROM rd_idempotency WHERE expires_at<=home_tunnel_now()");
  await db.query("DELETE FROM rd_tokens WHERE expires_at<=home_tunnel_now()");
}

export async function retainRdHistory(db: DatabaseClient) {
  await cleanupRd(db);
  await db.query(
    "UPDATE rd_pairings SET transcript_json='{}',host_proof=NULL,controller_proof=NULL WHERE expires_at<home_tunnel_add_seconds(home_tunnel_now(),-3600)",
  );
  await db.query(
    "DELETE FROM rd_audit WHERE created_at<home_tunnel_add_seconds(home_tunnel_now(),-2592000)",
  );
  await db.query(
    "DELETE FROM rd_usage_daily WHERE date_utc<substr(home_tunnel_add_seconds(home_tunnel_now(),-7776000),1,10)",
  );
}

export async function listEndpoints(
  owner: string,
  identity: RdIdentity | undefined,
  limit: number,
  offset: number,
) {
  const restricted = identity?.purpose === "host_online";
  const rows = await query<Endpoint>(
    "SELECT * FROM rd_endpoints WHERE owner_user_id=?" +
      (restricted ? " AND id=?" : "") +
      " ORDER BY created_at,id LIMIT ? OFFSET ?",
    restricted ? [owner, identity.endpoint.id, limit, offset] : [owner, limit, offset],
  );
  return { items: rows.map(endpointView), limit, offset };
}
export async function updateCapabilities(
  identity: RdIdentity,
  body: {
    local_enabled: boolean;
    capability_version: number;
    capabilities: Record<string, unknown>;
    signed_proof: string;
  },
) {
  requireHost(identity);
  return transaction(async (db) => {
    await assertLiveIdentity(db, identity);
    const payload = {
      endpoint_id: identity.endpoint.id,
      local_enabled: body.local_enabled,
      capability_version: body.capability_version,
      capabilities: body.capabilities,
    };
    if (
      canonical(
        verifyJws(
          body.signed_proof,
          publicJwk(JSON.parse(identity.endpoint.public_jwk)),
          "ht-rd-capabilities+jwt",
        ),
      ) !== canonical(payload)
    )
      fail(401, "RD_PROOF_INVALID", "能力签名不匹配");
    const result = await db.query(
      "UPDATE rd_endpoints SET local_enabled=?,capability_version=?,capability_json=?,updated_at=home_tunnel_now() WHERE id=? AND capability_version<?",
      [
        body.local_enabled,
        body.capability_version,
        JSON.stringify(body.capabilities),
        identity.endpoint.id,
        body.capability_version,
      ],
    );
    if (!result.rowCount) fail(409, "RD_VERSION_CONFLICT", "能力版本已变化");
    if (!body.local_enabled)
      await db.query(
        "UPDATE rd_sessions SET state='closing',close_reason='RD_HOST_DISABLED',state_version=state_version+1 WHERE host_endpoint_id=? AND state NOT IN ('closed','failed','expired','closing')",
        [identity.endpoint.id],
      );
    return endpointView(await endpointById(db, identity.endpoint.id));
  });
}

export async function createPairing(
  identity: RdIdentity,
  body: {
    host_endpoint_id: string;
    session_request_id: string;
    permissions: Permission[];
    mode: "one_session" | "persistent";
    nonce_controller: string;
  },
) {
  requireController(identity);
  return transaction(async (db) => {
    await assertLiveIdentity(db, identity);
    if (
      body.mode === "persistent" &&
      !(await first(
        db,
        "SELECT id FROM sessions WHERE id=? AND revoked_at IS NULL AND rd_verified_at>home_tunnel_add_seconds(home_tunnel_now(),-300)",
        [identity.parentSessionId],
      ))
    )
      fail(403, "RD_REAUTH_REQUIRED", "持久授权需要最近五分钟内重新验证账号");
    await cleanupRd(db);
    const host = await endpointById(db, body.host_endpoint_id, identity.endpoint.owner_user_id);
    if (
      host.id === identity.endpoint.id ||
      host.role === "controller" ||
      host.status !== "active" ||
      !host.local_enabled
    )
      fail(422, "RD_HOST_UNAVAILABLE", "被控端尚未开启远程桌面");
    const count = await first<{ count: number }>(
      db,
      "SELECT count(*) AS count FROM rd_pairings WHERE owner_user_id=? AND state='pending'",
      [host.owner_user_id],
    );
    if (Number(count?.count) >= 5) fail(429, "RD_PAIRING_LIMIT", "请先处理已有配对请求");
    const id = randomUUID(),
      expires_at = afterSeconds(60);
    const transcript = {
      domain: "ht-rd-pairing-v1",
      server_instance_id: (await serverState(db)).server_instance_id,
      pairing_id: id,
      host_endpoint_id: host.id,
      controller_endpoint_id: identity.endpoint.id,
      host_jkt: host.jkt,
      controller_jkt: identity.endpoint.jkt,
      nonce_host: null,
      nonce_controller: body.nonce_controller,
      scope: body.permissions,
      mode: body.mode,
      session_request_id: body.session_request_id,
      expires_at,
    };
    await db.query(
      "INSERT INTO rd_pairings(id,owner_user_id,host_endpoint_id,controller_endpoint_id,session_request_id,requested_scope_json,transcript_json,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      [
        id,
        host.owner_user_id,
        host.id,
        identity.endpoint.id,
        body.session_request_id,
        JSON.stringify(body.permissions),
        JSON.stringify(transcript),
        expires_at,
        nowIso(),
      ],
    );
    await audit(db, host.owner_user_id, "PairingRequested", id);
    return { id, state: "pending", expires_at, transcript };
  });
}
export async function pairing(identity: RdIdentity, id: string) {
  const row = await one(
    "SELECT * FROM rd_pairings WHERE id=? AND owner_user_id=? AND (host_endpoint_id=? OR controller_endpoint_id=?)",
    [id, identity.endpoint.owner_user_id, identity.endpoint.id, identity.endpoint.id],
  );
  if (!row) fail(404, "RD_NOT_FOUND", "配对请求不存在");
  const transcript = JSON.parse(row.transcript_json as string) as Record<string, unknown>;
  return {
    id,
    state: row.state,
    expires_at: row.expires_at,
    transcript,
    display_code: transcript.nonce_host
      ? Buffer.from(digest(canonical(transcript)), "base64url")
          .subarray(0, 16)
          .toString("hex")
          .match(/.{4}/g)!
          .join("-")
      : null,
    grant_id: row.state === "confirmed" ? id : null,
  };
}
export async function confirmPairing(
  identity: RdIdentity,
  id: string,
  body: { signed_proof: string; nonce_host?: string; grant_jws?: string },
) {
  await transaction(async (db) => {
    await assertLiveIdentity(db, identity);
    const row = await first(
      db,
      "SELECT * FROM rd_pairings WHERE id=? AND owner_user_id=? AND (host_endpoint_id=? OR controller_endpoint_id=?)",
      [id, identity.endpoint.owner_user_id, identity.endpoint.id, identity.endpoint.id],
    );
    if (!row) fail(404, "RD_NOT_FOUND", "配对请求不存在");
    if (row.state !== "pending" || timestamp(row.expires_at) <= Date.now())
      fail(409, "RD_PAIRING_EXPIRED", "配对已结束");
    const isHost = row.host_endpoint_id === identity.endpoint.id;
    const transcript = JSON.parse(row.transcript_json as string) as Record<string, unknown>;
    if (isHost) {
      requireHost(identity);
      if (!body.nonce_host || !body.grant_jws)
        fail(400, "RD_GRANT_REQUIRED", "本机批准必须包含随机数与签名授权");
      if (row.host_proof) fail(409, "RD_VERSION_CONFLICT", "本机已经确认配对");
      transcript.nonce_host = body.nonce_host;
    } else {
      requireController(identity);
      if (!row.host_proof || !transcript.nonce_host)
        fail(409, "RD_HOST_APPROVAL_REQUIRED", "等待被控端本机确认");
    }
    if (
      canonical(
        verifyJws(
          body.signed_proof,
          publicJwk(JSON.parse(identity.endpoint.public_jwk)),
          "ht-rd-pairing+jwt",
        ),
      ) !== canonical(transcript)
    )
      fail(401, "RD_PROOF_INVALID", "配对签名不匹配");
    if (isHost) {
      const host = await endpointById(db, String(row.host_endpoint_id));
      const controller = await endpointById(db, String(row.controller_endpoint_id));
      await storeGrant(db, host, controller, id, body.grant_jws!, transcript);
      await db.query("UPDATE rd_pairings SET host_proof=?,transcript_json=? WHERE id=?", [
        body.signed_proof,
        JSON.stringify(transcript),
        id,
      ]);
    } else {
      await db.query("UPDATE rd_pairings SET controller_proof=?,state='confirmed' WHERE id=?", [
        body.signed_proof,
        id,
      ]);
      await audit(db, identity.endpoint.owner_user_id, "PairingConfirmed", id);
    }
  });
  return pairing(identity, id);
}
async function storeGrant(
  db: DatabaseClient,
  host: Endpoint,
  controller: Endpoint,
  id: string,
  jws: string,
  transcript?: Record<string, unknown>,
) {
  const claims = verifyJws(jws, publicJwk(JSON.parse(host.public_jwk)), "ht-rd-grant+jwt");
  const state = await serverState(db);
  const allowed = [
    "id",
    "server_instance_id",
    "owner_user_id",
    "host_endpoint_id",
    "controller_endpoint_id",
    "host_jkt",
    "controller_jkt",
    "scope",
    "mode",
    "one_session_request_id",
    "grant_version",
    "expires_at",
  ];
  if (
    Object.keys(claims).some((k) => !allowed.includes(k)) ||
    claims.id !== id ||
    claims.server_instance_id !== state.server_instance_id ||
    claims.owner_user_id !== host.owner_user_id ||
    claims.host_endpoint_id !== host.id ||
    claims.controller_endpoint_id !== controller.id ||
    claims.host_jkt !== host.jkt ||
    claims.controller_jkt !== controller.jkt ||
    !Array.isArray(claims.scope) ||
    !claims.scope.includes("view") ||
    claims.scope.some((p) => !permissions.includes(p as Permission)) ||
    !["one_session", "persistent"].includes(String(claims.mode)) ||
    !Number.isSafeInteger(claims.grant_version) ||
    Number(claims.grant_version) < 1 ||
    (claims.expires_at !== null &&
      (typeof claims.expires_at !== "string" ||
        !Number.isFinite(timestamp(claims.expires_at)) ||
        timestamp(claims.expires_at) <= Date.now()))
  )
    fail(400, "RD_GRANT_INVALID", "本机授权内容无效");
  if (
    claims.mode === "one_session" &&
    (typeof claims.one_session_request_id !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(claims.one_session_request_id))
  )
    fail(400, "RD_GRANT_INVALID", "单次授权必须绑定会话请求");
  if (
    transcript &&
    (canonical(claims.scope) !== canonical(transcript.scope) ||
      claims.mode !== transcript.mode ||
      (claims.mode === "one_session" &&
        claims.one_session_request_id !== transcript.session_request_id))
  )
    fail(400, "RD_GRANT_INVALID", "授权与双方配对内容不同");
  if (claims.mode === "persistent") {
    const user = await first<{ mfa_secret: string | null }>(
      db,
      "SELECT mfa_secret FROM users WHERE id=?",
      [host.owner_user_id],
    );
    const capabilities = JSON.parse(host.capability_json) as Record<string, unknown>;
    if (!user?.mfa_secret || capabilities.unattended_enabled !== true)
      fail(403, "RD_UNATTENDED_DENIED", "持久授权需要 TOTP 与本机无人值守开关");
  }
  const existing = await first<Grant>(db, "SELECT * FROM rd_grants WHERE id=?", [id]);
  if (
    existing &&
    (existing.host_endpoint_id !== host.id ||
      existing.controller_endpoint_id !== controller.id ||
      existing.status !== "active" ||
      existing.grant_version >= Number(claims.grant_version))
  )
    fail(409, "RD_GRANT_VERSION_CONFLICT", "授权已撤销或版本过旧");
  await db.query(
    `INSERT INTO rd_grants(id,owner_user_id,host_endpoint_id,controller_endpoint_id,host_jkt,controller_jkt,scope_json,mode,one_session_request_id,grant_version,host_signature,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET scope_json=excluded.scope_json,mode=excluded.mode,one_session_request_id=excluded.one_session_request_id,grant_version=excluded.grant_version,host_signature=excluded.host_signature,expires_at=excluded.expires_at,updated_at=excluded.updated_at`,
    [
      id,
      host.owner_user_id,
      host.id,
      controller.id,
      host.jkt,
      controller.jkt,
      JSON.stringify(claims.scope),
      claims.mode,
      claims.one_session_request_id,
      claims.grant_version,
      jws,
      claims.expires_at,
      nowIso(),
      nowIso(),
    ],
  );
  await audit(db, host.owner_user_id, "GrantStored", id);
}
export async function putGrant(identity: RdIdentity, id: string, jws: string) {
  requireHost(identity);
  return transaction(async (db) => {
    await assertLiveIdentity(db, identity);
    const claims = verifyJws(
      jws,
      publicJwk(JSON.parse(identity.endpoint.public_jwk)),
      "ht-rd-grant+jwt",
    );
    const controller = await endpointById(
      db,
      String(claims.controller_endpoint_id),
      identity.endpoint.owner_user_id,
    );
    if (!(await first(db, "SELECT id FROM rd_pairings WHERE id=? AND state='confirmed'", [id])))
      fail(403, "RD_PAIRING_REQUIRED", "必须先完成双方配对");
    await storeGrant(db, identity.endpoint, controller, id, jws);
    return { id, grant_version: claims.grant_version, status: "active" };
  });
}
export async function rejectPairing(identity: RdIdentity, id: string) {
  return transaction(async (db) => {
    await assertLiveIdentity(db, identity);
    const result = await db.query(
      "UPDATE rd_pairings SET state='rejected',host_proof=NULL,controller_proof=NULL WHERE id=? AND owner_user_id=? AND (host_endpoint_id=? OR controller_endpoint_id=?) AND state IN ('pending','rejected')",
      [id, identity.endpoint.owner_user_id, identity.endpoint.id, identity.endpoint.id],
    );
    if (!result.rowCount) fail(404, "RD_NOT_FOUND", "配对请求不存在或已完成");
    await db.query(
      "UPDATE rd_grants SET status='revoked',grant_version=grant_version+1,revoked_at=home_tunnel_now() WHERE id=? AND status='active'",
      [id],
    );
  });
}
export async function revokeGrant(owner: string, id: string, hostId?: string) {
  return transaction(async (db) => {
    const grant = await first<Grant>(db, "SELECT * FROM rd_grants WHERE id=? AND owner_user_id=?", [
      id,
      owner,
    ]);
    if (!grant || (hostId && grant.host_endpoint_id !== hostId))
      fail(404, "RD_NOT_FOUND", "授权不存在");
    await db.query(
      "UPDATE rd_grants SET status='revoked',grant_version=grant_version+1,revoked_at=home_tunnel_now() WHERE id=? AND status='active'",
      [id],
    );
    await db.query(
      "UPDATE rd_sessions SET state='closing',state_version=state_version+1,close_reason='RD_GRANT_REVOKED' WHERE grant_id=? AND state NOT IN ('closed','failed','expired','closing')",
      [id],
    );
    await audit(db, owner, "GrantRevoked", id);
    await cleanupRd(db);
  });
}

export async function sessionView(row: Session, participant?: string) {
  const base = {
    id: row.id,
    session_id: row.id,
    session_request_id: row.session_request_id,
    host_endpoint_id: row.host_endpoint_id,
    controller_endpoint_id: row.controller_endpoint_id,
    state: row.state,
    state_version: row.state_version,
    connection_epoch: row.connection_epoch,
    permissions: JSON.parse(row.permissions_json) as Permission[],
    approval_expires_at: row.approval_expires_at,
    lease_expires_at: row.lease_expires_at,
    lease_seq: row.lease_seq,
    close_reason: row.close_reason,
    display_id: row.display_id,
  };
  if (participant !== row.host_endpoint_id && participant !== row.controller_endpoint_id)
    return base;
  const endpoints = await query<Endpoint>("SELECT * FROM rd_endpoints WHERE id IN (?,?)", [
    row.host_endpoint_id,
    row.controller_endpoint_id,
  ]);
  const grant = await one<Grant>("SELECT * FROM rd_grants WHERE id=?", [row.grant_id]);
  return {
    ...base,
    ticket_jws: row.ticket_jws,
    lease_jws: row.lease_jws,
    grant_jws: grant?.host_signature ?? null,
    host_public_jwk: JSON.parse(
      endpoints.find((e) => e.id === row.host_endpoint_id)!.public_jwk,
    ) as PublicJwk,
    controller_public_jwk: JSON.parse(
      endpoints.find((e) => e.id === row.controller_endpoint_id)!.public_jwk,
    ) as PublicJwk,
  };
}
export async function getSession(owner: string, id: string, participant?: string) {
  const row = await one<Session>("SELECT * FROM rd_sessions WHERE id=? AND owner_user_id=?", [
    id,
    owner,
  ]);
  if (
    !row ||
    (participant &&
      participant !== row.host_endpoint_id &&
      participant !== row.controller_endpoint_id)
  )
    fail(404, "RD_NOT_FOUND", "会话不存在");
  return sessionView(row, participant);
}
async function sessionFor(db: DatabaseClient, identity: RdIdentity, id: string) {
  await assertLiveIdentity(db, identity);
  const row = await first<Session>(
    db,
    "SELECT * FROM rd_sessions WHERE id=? AND owner_user_id=? AND (host_endpoint_id=? OR controller_endpoint_id=?)",
    [id, identity.endpoint.owner_user_id, identity.endpoint.id, identity.endpoint.id],
  );
  if (!row) fail(404, "RD_NOT_FOUND", "会话不存在");
  return row;
}
async function liveGrant(db: DatabaseClient, row: Session) {
  const grant = await first<Grant>(
    db,
    `SELECT g.* FROM rd_grants g JOIN users u ON u.id=g.owner_user_id JOIN rd_endpoints h ON h.id=g.host_endpoint_id JOIN rd_endpoints c ON c.id=g.controller_endpoint_id WHERE g.id=? AND g.status='active' AND (g.expires_at IS NULL OR g.expires_at>home_tunnel_now()) AND u.status='active' AND u.token_version=? AND h.status='active' AND h.local_enabled=1 AND c.status='active' AND EXISTS(SELECT 1 FROM sessions s WHERE s.id=? AND s.revoked_at IS NULL AND s.refresh_expires_at>home_tunnel_now() AND s.token_version=u.token_version)`,
    [row.grant_id, row.user_token_version, row.controller_parent_session_id],
  );
  if (!grant || grant.grant_version !== row.grant_version)
    fail(403, "RD_GRANT_REVOKED", "授权或父账号会话已失效");
  if (grant.mode === "persistent") {
    const user = await first(db, "SELECT mfa_secret FROM users WHERE id=?", [row.owner_user_id]);
    const host = await endpointById(db, row.host_endpoint_id);
    if (
      !user?.mfa_secret ||
      !(JSON.parse(host.capability_json) as Record<string, unknown>).unattended_enabled
    )
      fail(403, "RD_UNATTENDED_DENIED", "无人值守授权已关闭");
  }
  const scopes = JSON.parse(grant.scope_json) as Permission[];
  if ((JSON.parse(row.permissions_json) as Permission[]).some((p) => !scopes.includes(p)))
    fail(403, "RD_SCOPE_DENIED", "会话权限已撤销");
  return grant;
}
async function limits(db: DatabaseClient, owner: string) {
  let result = {
    sessions_per_user: rdConfig.sessionsPerUser,
    sessions_per_controller: rdConfig.sessionsPerController,
  };
  const policies = await db.query<{ scope_type: string; policy_json: string }>(
    "SELECT scope_type,policy_json FROM rd_policy WHERE scope_type='global' OR (scope_type='user' AND scope_id=?) ORDER BY scope_type",
    [owner],
  );
  for (const row of policies.rows) {
    const policy = JSON.parse(row.policy_json) as {
      enabled?: boolean;
      sessions_per_user?: number;
      sessions_per_controller?: number;
    };
    if (policy.enabled === false) fail(503, "RD_DISABLED", "远程桌面已关闭");
    result = {
      sessions_per_user: Math.min(
        result.sessions_per_user,
        policy.sessions_per_user ?? result.sessions_per_user,
      ),
      sessions_per_controller: Math.min(
        result.sessions_per_controller,
        policy.sessions_per_controller ?? result.sessions_per_controller,
      ),
    };
  }
  return result;
}
async function idempotent(
  db: DatabaseClient,
  identity: RdIdentity,
  operation: string,
  key: string,
  body: unknown,
  work: () => Promise<{ id: string }>,
) {
  const hash = digest(canonical(body));
  const existing = await first<{ request_hash: string; result_json: string }>(
    db,
    "SELECT * FROM rd_idempotency WHERE actor_endpoint_id=? AND operation=? AND key=?",
    [identity.endpoint.id, operation, key],
  );
  if (existing) {
    if (existing.request_hash !== hash)
      fail(409, "RD_IDEMPOTENCY_CONFLICT", "同一幂等键不能用于不同请求");
    return JSON.parse(existing.result_json) as { id: string };
  }
  const count = await first<{ count: number }>(
    db,
    "SELECT count(*) AS count FROM rd_idempotency WHERE actor_endpoint_id=?",
    [identity.endpoint.id],
  );
  if (Number(count?.count) >= 1000) fail(429, "RD_RATE_LIMITED", "幂等请求缓存已满");
  const result = await work();
  await db.query(
    "INSERT INTO rd_idempotency(actor_endpoint_id,operation,key,request_hash,result_status,result_json,expires_at) VALUES(?,?,?,?,202,?,?)",
    [identity.endpoint.id, operation, key, hash, JSON.stringify(result), afterSeconds(86400)],
  );
  return result;
}
export async function createSession(
  identity: RdIdentity,
  key: string,
  body: {
    host_endpoint_id: string;
    grant_id: string;
    permissions: Permission[];
    display_id: string;
    protocol: { major: number; minor: number };
    quality?: string;
  },
) {
  requireController(identity);
  const result = await transaction(async (db) => {
    await assertLiveIdentity(db, identity);
    await cleanupRd(db);
    return idempotent(db, identity, "create", key, body, async () => {
      await accountSignalBytes(identity.endpoint.owner_user_id, 0, 0, false, db);
      const policy = await limits(db, identity.endpoint.owner_user_id);
      if (body.protocol.major !== 1 || body.protocol.minor !== 0)
        fail(422, "RD_PROTOCOL_UNSUPPORTED", "不支持的远程桌面协议");
      const host = await endpointById(db, body.host_endpoint_id, identity.endpoint.owner_user_id);
      if (
        host.id === identity.endpoint.id ||
        host.role === "controller" ||
        host.status !== "active" ||
        !host.local_enabled
      )
        fail(422, "RD_HOST_UNAVAILABLE", "被控端当前不可用");
      const grant = await first<Grant>(
        db,
        "SELECT * FROM rd_grants WHERE id=? AND owner_user_id=? AND host_endpoint_id=? AND controller_endpoint_id=? AND status='active' AND (expires_at IS NULL OR expires_at>home_tunnel_now())",
        [body.grant_id, host.owner_user_id, host.id, identity.endpoint.id],
      );
      if (
        !grant ||
        !(await first(db, "SELECT id FROM rd_pairings WHERE id=? AND state='confirmed'", [
          body.grant_id,
        ]))
      )
        fail(403, "RD_PAIRING_REQUIRED", "请先完成双方配对");
      if (
        grant.mode === "one_session" &&
        (grant.one_session_request_id !== key ||
          (await first(db, "SELECT id FROM rd_sessions WHERE grant_id=?", [grant.id])))
      )
        fail(409, "RD_GRANT_CONSUMED", "本次授权只能用于对应的一个请求");
      const allowed = JSON.parse(grant.scope_json) as Permission[];
      const capability = JSON.parse(host.capability_json) as {
        permissions?: Permission[];
        status?: string;
        displays?: { id: string }[];
      };
      if (
        capability.status !== "ready" ||
        !capability.displays?.some((display) => display.id === body.display_id)
      )
        fail(422, "RD_HOST_UNAVAILABLE", "被控端未就绪或所选显示器不存在");
      if (
        !body.permissions.includes("view") ||
        body.permissions.some((p) => !allowed.includes(p) || !capability.permissions?.includes(p))
      )
        fail(403, "RD_SCOPE_DENIED", "请求超出本机授权或平台能力");
      const count = await first<{ count: number }>(
        db,
        "SELECT count(*) AS count FROM rd_sessions WHERE owner_user_id=? AND state NOT IN ('closed','failed','expired')",
        [host.owner_user_id],
      );
      const controllerCount = await first<{ count: number }>(
        db,
        "SELECT count(*) AS count FROM rd_session_slots WHERE endpoint_id=? AND role='controller'",
        [identity.endpoint.id],
      );
      const conflicting = await first(
        db,
        "SELECT session_id FROM rd_session_slots WHERE (endpoint_id=? AND role='host') OR endpoint_id=?",
        [identity.endpoint.id, host.id],
      );
      if (
        Number(count?.count) >= policy.sessions_per_user ||
        Number(controllerCount?.count) >= policy.sessions_per_controller ||
        conflicting
      )
        fail(429, "RD_SESSION_LIMIT", "会话数量已达上限或设备正在使用");
      const state = await serverState(db),
        id = randomUUID(),
        now = nowIso(),
        deadline = afterSeconds(60);
      await db.query(
        "INSERT INTO rd_sessions(id,owner_user_id,host_endpoint_id,controller_endpoint_id,controller_parent_session_id,user_token_version,grant_id,grant_version,permissions_json,display_id,state,restore_epoch,approval_expires_at,created_at,updated_at,session_request_id) VALUES(?,?,?,?,?,?,?,?,?,?,'pending_approval',?,?,?,?,?)",
        [
          id,
          host.owner_user_id,
          host.id,
          identity.endpoint.id,
          identity.parentSessionId,
          identity.tokenVersion,
          grant.id,
          grant.grant_version,
          JSON.stringify(body.permissions),
          body.display_id,
          state.restore_epoch,
          deadline,
          now,
          now,
          key,
        ],
      );
      await db.query(
        "INSERT INTO rd_session_slots(endpoint_id,session_id,role,hold_until) VALUES(?,?,'host',?),(?,?,'controller',?)",
        [host.id, id, deadline, identity.endpoint.id, id, deadline],
      );
      await liveGrant(
        db,
        (await first<Session>(db, "SELECT * FROM rd_sessions WHERE id=?", [id]))!,
      );
      await audit(db, host.owner_user_id, "SessionRequested", id);
      return { id };
    });
  });
  rdEvents.emit("session", result.id);
  return getSession(identity.endpoint.owner_user_id, result.id, identity.endpoint.id);
}
async function signedAuthorization(db: DatabaseClient, row: Session, renew: boolean) {
  const state = await serverState(db),
    host = await endpointById(db, row.host_endpoint_id),
    controller = await endpointById(db, row.controller_endpoint_id);
  if (state.restore_epoch !== row.restore_epoch)
    fail(401, "RD_RESTORE_EPOCH_INVALID", "恢复代次已变化");
  const iat = Math.floor(Date.now() / 1000),
    reconnect = row.lease_expires_at !== null && !renew;
  const grant = await liveGrant(db, row);
  const stored = await first<{ keyset_json: string }>(
    db,
    "SELECT keyset_json FROM rd_server_state WHERE id=1",
  );
  if (!stored?.keyset_json) fail(503, "RD_UNAVAILABLE", "服务器签名公钥尚未初始化");
  const manifest = parseManifest(stored.keyset_json),
    activeKey = manifest.keys.find((key) => key.kid === manifest.active_kid)!;
  if (timestamp(activeKey.not_before) > Date.now() || timestamp(activeKey.not_after) <= Date.now())
    fail(503, "RD_KEY_EXPIRED", "服务器签名公钥需要轮换");
  const exp = Math.min(
    Math.floor(timestamp(activeKey.not_after) / 1000),
    grant.expires_at ? Math.floor(timestamp(grant.expires_at) / 1000) : Number.MAX_SAFE_INTEGER,
    reconnect ? Math.floor(timestamp(row.lease_expires_at) / 1000) : iat + rdConfig.leaseSeconds,
  );
  if (exp <= iat) fail(409, "RD_LEASE_EXPIRED", "会话租约已过期");
  const common = {
    iss: config.publicBaseUrl,
    server_instance_id: state.server_instance_id,
    restore_epoch: state.restore_epoch,
    session_id: row.id,
    session_request_id: row.session_request_id,
    connection_epoch: row.connection_epoch,
    owner_user_id: row.owner_user_id,
    controller_endpoint_id: controller.id,
    host_endpoint_id: host.id,
    controller_jkt: controller.jkt,
    host_jkt: host.jkt,
    permissions: JSON.parse(row.permissions_json) as Permission[],
    grant_id: row.grant_id,
    grant_version: row.grant_version,
    user_token_version: row.user_token_version,
    iat,
    nbf: iat,
  };
  const lease_seq = row.lease_seq + 1,
    lease = signJws(
      { ...common, aud: "ht-rd-use", jti: randomUUID(), exp, lease_seq },
      "ht-rd-lease+jwt",
    );
  const ticket_jti = renew ? row.ticket_jti : randomUUID();
  const ticket = renew
    ? row.ticket_jws
    : signJws(
        { ...common, aud: "ht-rd-start", jti: ticket_jti, exp: Math.min(iat + 60, exp) },
        "ht-rd-ticket+jwt",
      );
  await db.query(
    "UPDATE rd_sessions SET ticket_jti=?,ticket_jws=?,ticket_expires_at=?,lease_seq=?,lease_jws=?,lease_issued_at=?,lease_expires_at=?,state=?,state_version=state_version+1,updated_at=home_tunnel_now() WHERE id=?",
    [
      ticket_jti,
      ticket,
      renew ? row.ticket_expires_at : new Date(Math.min(iat + 60, exp) * 1000),
      lease_seq,
      lease,
      new Date(iat * 1000),
      new Date(exp * 1000),
      renew ? row.state : "authorized",
      row.id,
    ],
  );
  await db.query("UPDATE rd_session_slots SET hold_until=? WHERE session_id=?", [
    new Date(exp * 1000),
    row.id,
  ]);
}
export async function decideSession(
  identity: RdIdentity,
  id: string,
  body: {
    decision: "accept" | "reject";
    grant_version: number;
    permissions: Permission[];
    expected_version: number;
    signed_proof: string;
  },
) {
  requireHost(identity);
  await transaction(async (db) => {
    await cleanupRd(db);
    const row = await sessionFor(db, identity, id);
    if (row.host_endpoint_id !== identity.endpoint.id)
      fail(403, "RD_HOST_REQUIRED", "只有目标被控端可批准");
    if (
      !["pending_approval", "reconnecting"].includes(row.state) ||
      row.state_version !== body.expected_version
    )
      fail(409, "RD_VERSION_CONFLICT", "会话阶段或版本已变化");
    const expected = {
      type: "session.decision",
      session_id: id,
      connection_epoch: row.connection_epoch,
      decision: body.decision,
      grant_version: body.grant_version,
      permissions: body.permissions,
      expected_version: body.expected_version,
    };
    if (
      canonical(
        verifyJws(
          body.signed_proof,
          publicJwk(JSON.parse(identity.endpoint.public_jwk)),
          "ht-rd-session+jwt",
        ),
      ) !== canonical(expected)
    )
      fail(401, "RD_PROOF_INVALID", "本机决定签名无效");
    if (body.decision === "reject") {
      // A reconnect rejection may still have a live old media epoch: retain its slot.
      await db.query(
        "UPDATE rd_sessions SET state=?,state_version=state_version+1,close_reason='RD_HOST_REJECTED' WHERE id=?",
        [row.lease_expires_at ? "closing" : "failed", id],
      );
      await cleanupRd(db);
      return;
    }
    await liveGrant(db, row);
    const requested = JSON.parse(row.permissions_json) as Permission[];
    if (
      body.grant_version !== row.grant_version ||
      !body.permissions.includes("view") ||
      body.permissions.some((p) => !requested.includes(p))
    )
      fail(403, "RD_SCOPE_DENIED", "本机授权不能扩大请求权限");
    row.permissions_json = JSON.stringify(body.permissions);
    await db.query("UPDATE rd_sessions SET permissions_json=? WHERE id=?", [
      row.permissions_json,
      id,
    ]);
    await signedAuthorization(db, row, false);
    await audit(db, row.owner_user_id, "SessionAuthorized", id);
  });
  rdEvents.emit("session", id);
  return getSession(identity.endpoint.owner_user_id, id, identity.endpoint.id);
}
export async function renewSession(
  identity: RdIdentity,
  id: string,
  body: { current_epoch: number; last_lease_seq: number; signed_proof: string },
) {
  requireHost(identity);
  await transaction(async (db) => {
    await cleanupRd(db);
    const row = await sessionFor(db, identity, id);
    if (
      row.host_endpoint_id !== identity.endpoint.id ||
      !["authorized", "connecting", "active", "reconnecting"].includes(row.state) ||
      row.connection_epoch !== body.current_epoch
    )
      fail(409, "RD_STATE_CONFLICT", "该会话不能续租");
    const proof = {
      type: "session.renew",
      session_id: id,
      connection_epoch: body.current_epoch,
      last_lease_seq: body.last_lease_seq,
      grant_id: row.grant_id,
      grant_version: row.grant_version,
    };
    if (
      canonical(
        verifyJws(
          body.signed_proof,
          publicJwk(JSON.parse(identity.endpoint.public_jwk)),
          "ht-rd-session+jwt",
        ),
      ) !== canonical(proof)
    )
      fail(401, "RD_PROOF_INVALID", "续租证明无效");
    await liveGrant(db, row);
    await limits(db, row.owner_user_id);
    if (row.lease_seq === body.last_lease_seq + 1) return;
    if (
      row.lease_seq !== body.last_lease_seq ||
      !row.lease_expires_at ||
      timestamp(row.lease_expires_at) <= Date.now()
    )
      fail(409, "RD_LEASE_CONFLICT", "租约序号已变化");
    const slots = await first<{ count: number }>(
      db,
      "SELECT count(*) AS count FROM rd_session_slots WHERE session_id=?",
      [id],
    );
    if (slots?.count !== 2) fail(409, "RD_SLOT_INVALID", "会话占位已失效");
    // Do not turn repeated eager renewals into unbounded signing work.
    if (timestamp(row.lease_issued_at) > Date.now() - 240000)
      fail(409, "RD_RENEW_TOO_EARLY", "租约尚无需续期");
    await signedAuthorization(db, row, true);
  });
  rdEvents.emit("session", id);
  return getSession(identity.endpoint.owner_user_id, id, identity.endpoint.id);
}
export async function reconnectSession(
  identity: RdIdentity,
  id: string,
  key: string,
  body: { expected_epoch: number; reason: string; display_id?: string },
) {
  requireController(identity);
  await transaction(async (db) => {
    await cleanupRd(db);
    const row = await sessionFor(db, identity, id);
    if (row.controller_endpoint_id !== identity.endpoint.id)
      fail(403, "RD_CONTROLLER_REQUIRED", "仅原控制端可重建会话");
    await idempotent(db, identity, `reconnect:${id}`, key, body, async () => {
      const displayChanged = body.reason === "display_changed";
      if (
        !["active", "connecting", "authorized"].includes(row.state) ||
        row.connection_epoch !== body.expected_epoch ||
        row.connection_epoch >= 0xffffffff ||
        (!displayChanged && row.network_reconnect_count >= 3)
      )
        fail(409, "RD_RECONNECT_LIMIT", "会话无法再次重建");
      if (
        displayChanged
          ? !body.display_id || body.display_id === row.display_id
          : body.display_id !== undefined
      )
        fail(422, "RD_HOST_UNAVAILABLE", "切换显示器必须选择另一块可用显示器");
      await liveGrant(db, row);
      const host = await endpointById(db, row.host_endpoint_id),
        displayId = body.display_id ?? row.display_id,
        capability = JSON.parse(host.capability_json) as {
          status?: string;
          displays?: { id: string }[];
        };
      if (
        capability.status !== "ready" ||
        !capability.displays?.some((display) => display.id === displayId)
      )
        fail(422, "RD_HOST_UNAVAILABLE", "被控端未就绪或所选显示器不存在");
      await db.query(
        "UPDATE rd_sessions SET state='reconnecting',display_id=?,connection_epoch=connection_epoch+1,network_reconnect_count=network_reconnect_count+?,state_version=state_version+1,ticket_jws=NULL,ticket_jti=NULL,host_ready=0,controller_ready=0,updated_at=home_tunnel_now() WHERE id=?",
        [displayId, displayChanged ? 0 : 1, id],
      );
      return { id };
    });
  });
  rdEvents.emit("session", id);
  return getSession(identity.endpoint.owner_user_id, id, identity.endpoint.id);
}
export async function reportSession(
  identity: RdIdentity,
  id: string,
  body: {
    phase: "connecting" | "ready" | "failed";
    connection_epoch: number;
    expected_version: number;
    error_code?: string;
    path_verified?: boolean;
  },
) {
  await transaction(async (db) => {
    await cleanupRd(db);
    const row = await sessionFor(db, identity, id);
    if (
      row.connection_epoch !== body.connection_epoch ||
      row.state_version !== body.expected_version ||
      !["authorized", "connecting", "active"].includes(row.state)
    )
      fail(409, "RD_STATE_CONFLICT", "会话报告已过期");
    if (body.phase === "failed") {
      await db.query(
        "UPDATE rd_sessions SET state='closing',state_version=state_version+1,close_reason=? WHERE id=?",
        [body.error_code ?? "RD_MEDIA_FAILED", id],
      );
      return;
    }
    await liveGrant(db, row);
    const isHost = row.host_endpoint_id === identity.endpoint.id;
    if (body.phase === "ready" && isHost && body.path_verified !== true)
      fail(422, "RD_NO_DIRECT_PATH", "被控端必须先验证 UDP 直连");
    const hostReady = row.host_ready || (isHost && body.phase === "ready"),
      controllerReady = row.controller_ready || (!isHost && body.phase === "ready");
    await db.query(
      "UPDATE rd_sessions SET host_ready=?,controller_ready=?,state=?,state_version=state_version+1,updated_at=home_tunnel_now() WHERE id=?",
      [
        Boolean(hostReady),
        Boolean(controllerReady),
        hostReady && controllerReady ? "active" : "connecting",
        id,
      ],
    );
  });
  rdEvents.emit("session", id);
  return getSession(identity.endpoint.owner_user_id, id, identity.endpoint.id);
}
export async function closeSession(
  owner: string,
  id: string,
  reason: string,
  participant?: string,
  admin = false,
) {
  await transaction(async (db) => {
    const row = await first<Session>(
      db,
      "SELECT * FROM rd_sessions WHERE id=?" + (admin ? "" : " AND owner_user_id=?"),
      admin ? [id] : [id, owner],
    );
    if (
      !row ||
      (participant &&
        participant !== row.host_endpoint_id &&
        participant !== row.controller_endpoint_id)
    )
      fail(404, "RD_NOT_FOUND", "会话不存在");
    if (!terminal.includes(row.state) && row.state !== "closing")
      await db.query(
        "UPDATE rd_sessions SET state='closing',state_version=state_version+1,close_reason=?,updated_at=home_tunnel_now() WHERE id=?",
        [reason, id],
      );
    await cleanupRd(db);
    await audit(db, row.owner_user_id, admin ? "SessionAdminRevoked" : "SessionCloseRequested", id);
  });
  rdEvents.emit("session", id);
}
export async function closeAck(
  identity: RdIdentity,
  id: string,
  body: { connection_epoch: number; lease_seq: number; signed_proof: string },
) {
  requireHost(identity);
  await transaction(async (db) => {
    const row = await sessionFor(db, identity, id);
    if (
      row.host_endpoint_id !== identity.endpoint.id ||
      row.connection_epoch !== body.connection_epoch ||
      row.lease_seq !== body.lease_seq
    )
      fail(409, "RD_STATE_CONFLICT", "关闭确认代次无效");
    const proof = {
      type: "session.close_ack",
      session_id: id,
      connection_epoch: body.connection_epoch,
      lease_seq: body.lease_seq,
      stopped: true,
    };
    if (
      canonical(
        verifyJws(
          body.signed_proof,
          publicJwk(JSON.parse(identity.endpoint.public_jwk)),
          "ht-rd-session+jwt",
        ),
      ) !== canonical(proof)
    )
      fail(401, "RD_PROOF_INVALID", "关闭确认签名无效");
    await db.query(
      "UPDATE rd_sessions SET state='closed',state_version=state_version+1,host_close_ack=?,closed_at=home_tunnel_now(),updated_at=home_tunnel_now() WHERE id=? AND state NOT IN ('closed','failed','expired')",
      [body.signed_proof, id],
    );
    await db.query("DELETE FROM rd_session_slots WHERE session_id=?", [id]);
  });
  rdEvents.emit("session", id);
}
