import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { isIP } from "node:net";
import { WebSocket, WebSocketServer, type ServerOptions } from "ws";
import { z } from "zod";
import { config } from "../config.js";
import { one, query, transaction } from "../db.js";
import { HttpError } from "../http.js";
import { FixedWindowLimiter } from "../security.js";
import { registerUpgrade } from "../upgrades.js";
import { rdConfig } from "./config.js";
import { publicJwk, strictJson, verifyJws } from "./crypto.js";
import * as rd from "./service.js";

type Connection = {
  socket: WebSocket;
  id: string;
  nonce: string;
  identity?: rd.RdIdentity;
  generation: number;
  alive: boolean;
  sentReauth: boolean;
  seen: Map<string, { maximum: bigint; values: Set<bigint> }>;
  candidates: Map<string, number>;
  rateTokens: number;
  rateAt: number;
  serial: Promise<void>;
  pending: number;
  versions: Map<string, number>;
  presenceSubscribed: boolean;
  presenceDigest: string;
};
const sockets = new Map<string, Connection>();
let presenceVersion = 0;
const uuid = z.string().uuid();
const candidate = z.strictObject({
  candidate: z.string().max(1024),
  sdpMid: z.string().max(64).nullable(),
  sdpMLineIndex: z.number().int().min(0).max(16).nullable(),
  usernameFragment: z.string().max(256).optional(),
});
const envelopeSchema = z.strictObject({
  v: z.literal(1),
  type: z.enum(["peer.offer", "peer.answer", "peer.candidates", "peer.candidates_done"]),
  request_id: uuid,
  session_id: uuid,
  connection_epoch: z.number().int().positive(),
  payload_jws: z.string().max(65536),
});
const payloadSchema = z.strictObject({
  v: z.literal(1),
  type: z.enum(["peer.offer", "peer.answer", "peer.candidates", "peer.candidates_done"]),
  session_id: uuid,
  connection_epoch: z.number().int().positive(),
  from_endpoint_id: uuid,
  to_endpoint_id: uuid,
  seq: z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/),
  ticket_jti: uuid,
  created_at: z.string().datetime(),
  payload: z.unknown(),
});
export function candidateAllowed(value: string) {
  if (!value) return true;
  const parts = value.trim().replace(/^a=/, "").split(/\s+/);
  if (
    parts.length < 8 ||
    !parts[0]!.startsWith("candidate:") ||
    parts[2]!.toLowerCase() !== "udp" ||
    parts[6] !== "typ" ||
    !["host", "srflx", "prflx"].includes(parts[7]!)
  )
    return false;
  const address = parts[4]!.toLowerCase();
  if (!/^[1-9][0-9]{0,4}$/.test(parts[5]!) || Number(parts[5]) > 65535) return false;
  const family = isIP(address);
  if (
    ["0.0.0.0", "::", "::1", "255.255.255.255"].includes(address) ||
    (family === 4 && /^127\.|^22[4-9]\.|^23\d\./.test(address)) ||
    (family === 6 && /^(?:ff|fe[89ab][0-9a-f]:|::ffff:)/.test(address))
  )
    return false;
  if (!family && !/^[a-z0-9-]{1,63}\.local$/.test(address)) return false;
  return true;
}
const reservedTypes = new Set([
  "ping",
  "pong",
  "presence.subscribe",
  "presence.changed",
  "session.close",
  "session.close_ack",
  "session.revoked",
  "session.state",
  "auth",
  "auth.reauth",
  "auth.ok",
  "auth.renewed",
  "auth.reauth_required",
  "error",
]);
async function send(connection: Connection, message: unknown) {
  if (connection.socket.readyState !== WebSocket.OPEN) return;
  if (connection.socket.bufferedAmount > rdConfig.queueBytes) {
    connection.socket.close(1008, "backpressure");
    return;
  }
  const serialized = JSON.stringify(message);
  if (connection.identity) {
    try {
      await rd.accountSignalBytes(
        connection.identity.endpoint.owner_user_id,
        0,
        Buffer.byteLength(serialized),
        reservedTypes.has(String((message as { type?: string }).type)),
      );
    } catch (error) {
      connection.socket.close(1008, "signal budget");
      throw error;
    }
  }
  if (connection.socket.readyState === WebSocket.OPEN) connection.socket.send(serialized);
}
async function forwardPeer(connection: Connection, message: unknown) {
  const envelope = envelopeSchema.parse(message),
    identity = connection.identity!;
  await rd.requireEnabled();
  const row = await one<rd.Session>(
    "SELECT * FROM rd_sessions WHERE id=? AND owner_user_id=? AND (host_endpoint_id=? OR controller_endpoint_id=?)",
    [
      envelope.session_id,
      identity.endpoint.owner_user_id,
      identity.endpoint.id,
      identity.endpoint.id,
    ],
  );
  if (
    !row ||
    !["authorized", "connecting"].includes(row.state) ||
    row.connection_epoch !== envelope.connection_epoch ||
    !row.ticket_jti ||
    rd.timestamp(row.ticket_expires_at) <= Date.now()
  )
    rd.fail(409, "RD_SIGNAL_STATE", "会话不处于建连窗口");
  if (rd.timestamp(row.lease_issued_at) + 20000 < Date.now())
    rd.fail(409, "RD_ICE_DEADLINE", "候选交换窗口已结束");
  const payload = payloadSchema.parse(
    verifyJws(
      envelope.payload_jws,
      publicJwk(JSON.parse(identity.endpoint.public_jwk)),
      "ht-rd-peer+jwt",
    ),
  );
  const target =
    identity.endpoint.id === row.host_endpoint_id
      ? row.controller_endpoint_id
      : row.host_endpoint_id;
  if (
    payload.session_id !== envelope.session_id ||
    payload.connection_epoch !== envelope.connection_epoch ||
    payload.type !== envelope.type ||
    payload.from_endpoint_id !== identity.endpoint.id ||
    payload.to_endpoint_id !== target ||
    payload.ticket_jti !== row.ticket_jti ||
    Math.abs(Date.now() - Date.parse(payload.created_at)) > 60000 ||
    BigInt(payload.seq) > 18446744073709551615n
  )
    rd.fail(401, "RD_PROOF_INVALID", "信令签名标识不匹配");
  if (
    (payload.type === "peer.offer" && identity.endpoint.id !== row.controller_endpoint_id) ||
    (payload.type === "peer.answer" && identity.endpoint.id !== row.host_endpoint_id)
  )
    rd.fail(403, "RD_SIGNAL_ROLE", "信令方向错误");
  const key = `${row.id}:${row.connection_epoch}`,
    seq = BigInt(payload.seq);
  let seen = connection.seen.get(key);
  if (!seen) {
    if (connection.seen.size >= 64) rd.fail(429, "RD_RATE_LIMITED", "过多信令会话");
    seen = { maximum: -1n, values: new Set() };
    connection.seen.set(key, seen);
  }
  if (
    seen.values.has(seq) ||
    seq + 32n <= seen.maximum ||
    (!payload.type.startsWith("peer.candidates") && seq <= seen.maximum)
  )
    rd.fail(401, "RD_PROOF_REPLAY", "信令序号已使用");
  if (payload.type === "peer.offer" || payload.type === "peer.answer") {
    const data = z
      .strictObject({ type: z.enum(["offer", "answer"]), sdp: z.string().max(24576) })
      .parse(payload.payload);
    if (
      data.type !== payload.type.slice(5) ||
      !data.sdp.startsWith("v=0") ||
      Buffer.byteLength(data.sdp) > 24576
    )
      rd.fail(400, "RD_SDP_INVALID", "SDP 无效");
    const candidates = data.sdp.split(/\r?\n/).filter((line) => line.startsWith("a=candidate:"));
    if (
      candidates.some((line) => !candidateAllowed(line)) ||
      candidates.length > 32 ||
      /a=setup:holdconn|a=ice-lite/i.test(data.sdp)
    )
      rd.fail(422, "RD_NO_DIRECT_PATH", "只允许标准 UDP 直接候选");
    connection.candidates.set(key, (connection.candidates.get(key) ?? 0) + candidates.length);
  } else if (payload.type === "peer.candidates") {
    const data = z
      .strictObject({ candidates: z.array(candidate).min(1).max(32) })
      .parse(payload.payload);
    if (data.candidates.some((item) => !candidateAllowed(item.candidate)))
      rd.fail(422, "RD_NO_DIRECT_PATH", "不允许中继或 TCP 候选");
    connection.candidates.set(key, (connection.candidates.get(key) ?? 0) + data.candidates.length);
  } else z.strictObject({}).parse(payload.payload);
  if ((connection.candidates.get(key) ?? 0) > 32)
    rd.fail(429, "RD_CANDIDATE_LIMIT", "候选数已达上限");
  const recipient = sockets.get(target);
  if (!recipient) rd.fail(409, "RD_PEER_OFFLINE", "对端信令离线");
  seen.values.add(seq);
  if (seq > seen.maximum) seen.maximum = seq;
  for (const value of seen.values) if (value + 32n <= seen.maximum) seen.values.delete(value);
  // Do not decode/re-encode payload_jws: the exact signed bytes reach the peer.
  await send(recipient, envelope);
}
async function sendSession(id: string) {
  const row = await one<rd.Session>("SELECT * FROM rd_sessions WHERE id=?", [id]);
  if (!row) return;
  for (const endpointId of [row.host_endpoint_id, row.controller_endpoint_id]) {
    const connection = sockets.get(endpointId);
    if (!connection || connection.versions.get(id) === row.state_version) continue;
    if (connection.versions.size >= 64)
      connection.versions.delete(connection.versions.keys().next().value!);
    connection.versions.set(id, row.state_version);
    const type =
      row.state === "pending_approval"
        ? "session.request"
        : row.state === "authorized"
          ? "session.authorized"
          : row.state === "closing"
            ? "session.revoked"
            : row.state === "reconnecting"
              ? "session.reconnect_requested"
              : "session.state";
    await send(connection, {
      v: 1,
      type,
      session_id: id,
      connection_epoch: row.connection_epoch,
      payload: await rd.sessionView(row, endpointId),
    });
  }
}
async function sendPairing(id: string) {
  const row = await one(
    "SELECT host_endpoint_id,controller_endpoint_id FROM rd_pairings WHERE id=?",
    [id],
  );
  if (!row) return;
  for (const endpoint of [String(row.host_endpoint_id), String(row.controller_endpoint_id)]) {
    const connection = sockets.get(endpoint);
    if (connection?.identity)
      await send(connection, {
        v: 1,
        type: "pairing.updated",
        payload: await rd.pairing(connection.identity, id),
      });
  }
}
async function sendPresence(connection: Connection, force = false) {
  if (!connection.identity || !connection.presenceSubscribed) return;
  const result = await rd.listEndpoints(
    connection.identity.endpoint.owner_user_id,
    connection.identity,
    100,
    0,
  );
  const items = result.items.map((endpoint) => ({
    id: endpoint.id,
    online: endpoint.online,
    local_enabled: endpoint.local_enabled,
    status: endpoint.status,
  }));
  const digest = JSON.stringify(items);
  if (!force && digest === connection.presenceDigest) return;
  connection.presenceDigest = digest;
  await send(connection, {
    v: 1,
    type: "presence.changed",
    presence_version: ++presenceVersion,
    items,
  });
}
async function changedPresence(owner: string) {
  for (const connection of sockets.values())
    if (connection.identity?.endpoint.owner_user_id === owner) await sendPresence(connection);
}
export function rdPresence(endpointId: string) {
  return sockets.has(endpointId);
}
export function attachRdSignaling(server: Server) {
  const options: ServerOptions & { maxFragments: number; maxBufferedChunks: number } = {
    noServer: true,
    perMessageDeflate: false,
    maxPayload: rdConfig.messageBytes,
    maxFragments: 128,
    maxBufferedChunks: 256,
  };
  const wss = new WebSocketServer(options);
  const all = new Set<Connection>();
  let stopping = false,
    unauthenticated = 0;
  const handshakeLimiter = new FixedWindowLimiter(20, 60000);
  const unregister = registerUpgrade(server, "/api/v1/rd/signal", (request, socket, head) => {
    const reject = (status: number) => {
      socket.write(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (!rdConfig.enabled || stopping) {
      reject(503);
      return;
    }
    if (request.headers.origin && request.headers.origin !== new URL(config.publicBaseUrl).origin) {
      reject(403);
      return;
    }
    if (
      request.headers["sec-websocket-protocol"] !== "ht.rd.signal.v1" ||
      (request.url ?? "").includes("?")
    ) {
      reject(400);
      return;
    }
    if (
      unauthenticated >= rdConfig.maxUnauthenticated ||
      all.size >= rdConfig.maxConnections + rdConfig.maxUnauthenticated ||
      !handshakeLimiter.take(request.socket.remoteAddress ?? "unknown").allowed
    ) {
      reject(429);
      return;
    }
    unauthenticated++;
    try {
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws));
    } catch {
      unauthenticated--;
      socket.destroy();
    }
  });
  wss.on("connection", (socket: WebSocket) => {
    const connection: Connection = {
      socket,
      id: randomUUID(),
      nonce: randomBytes(32).toString("base64url"),
      generation: 0,
      alive: true,
      sentReauth: false,
      seen: new Map(),
      candidates: new Map(),
      rateTokens: 40,
      rateAt: Date.now(),
      serial: Promise.resolve(),
      pending: 0,
      versions: new Map(),
      presenceSubscribed: false,
      presenceDigest: "",
    };
    all.add(connection);
    let countedUnauth = true;
    const deadline = setTimeout(() => {
      if (!connection.identity) socket.close(1008, "authentication timeout");
    }, 5000);
    deadline.unref();
    void send(connection, {
      v: 1,
      type: "auth.challenge",
      connection_id: connection.id,
      nonce: connection.nonce,
    }).catch(() => socket.close(1008, "challenge failure"));
    socket.on("error", () => undefined);
    socket.on("pong", () => {
      connection.alive = true;
    });
    socket.once("close", () => {
      clearTimeout(deadline);
      all.delete(connection);
      if (countedUnauth) unauthenticated--;
      const endpoint = connection.identity?.endpoint.id;
      if (endpoint && sockets.get(endpoint) === connection) {
        sockets.delete(endpoint);
        rd.rdOnlineEndpoints.delete(endpoint);
        void changedPresence(connection.identity!.endpoint.owner_user_id).catch(() => undefined);
      }
    });
    socket.on("message", (data, binary) => {
      if (binary || connection.pending >= 8) {
        socket.close(1008, "message limit");
        return;
      }
      connection.pending++;
      connection.serial = connection.serial
        .then(async () => {
          const now = Date.now();
          connection.rateTokens = Math.min(
            40,
            connection.rateTokens + Math.max(0, now - connection.rateAt) * 0.02,
          );
          connection.rateAt = now;
          if (connection.rateTokens < 1) rd.fail(429, "RD_RATE_LIMITED", "信令发送过快");
          connection.rateTokens -= 1;
          const message = strictJson(
            new TextDecoder("utf-8", { fatal: true }).decode(data as Buffer),
          ) as Record<string, unknown>;
          if (!connection.identity || message.type === "auth.reauth") {
            const auth = z
              .strictObject({
                v: z.literal(1),
                type: z.enum(["auth", "auth.reauth"]),
                ticket: z.string().max(128),
                proof: z.string().max(8192),
              })
              .parse(message);
            if (connection.identity && auth.type !== "auth.reauth")
              rd.fail(401, "RD_AUTH_INVALID", "信令已认证");
            const next = await rd.authenticateSignal(
              auth.ticket,
              auth.proof,
              connection.id,
              connection.nonce,
            );
            if (
              connection.identity &&
              connection.identity.endpoint.id !== next.identity.endpoint.id
            )
              rd.fail(403, "RD_IDENTITY_CHANGED", "不能改变信令身份");
            const previous = sockets.get(next.identity.endpoint.id);
            if (!connection.identity && sockets.size >= rdConfig.maxConnections && !previous)
              rd.fail(429, "RD_CONNECTION_LIMIT", "信令连接数已达上限");
            await rd.accountSignalBytes(
              next.identity.endpoint.owner_user_id,
              Buffer.byteLength(data as Buffer),
              0,
              true,
            );
            connection.identity = next.identity;
            connection.generation = next.generation;
            connection.sentReauth = false;
            if (countedUnauth) {
              unauthenticated--;
              countedUnauth = false;
            }
            clearTimeout(deadline);
            sockets.set(next.identity.endpoint.id, connection);
            rd.rdOnlineEndpoints.add(next.identity.endpoint.id);
            if (previous && previous !== connection)
              previous.socket.close(4001, "replaced by newer generation");
            await send(connection, {
              v: 1,
              type: auth.type === "auth" ? "auth.ok" : "auth.renewed",
              connection_id: connection.id,
              endpoint_id: next.identity.endpoint.id,
              generation: next.generation,
              expires_at: new Date(next.identity.expiresAt).toISOString(),
            });
            const sessions = await query<{ id: string }>(
              "SELECT id FROM rd_sessions WHERE (host_endpoint_id=? OR controller_endpoint_id=?) AND state NOT IN ('closed','failed','expired')",
              [next.identity.endpoint.id, next.identity.endpoint.id],
            );
            for (const session of sessions) await sendSession(session.id);
            const pairings = await query<{ id: string }>(
              "SELECT id FROM rd_pairings WHERE (host_endpoint_id=? OR controller_endpoint_id=?) AND state='pending' AND expires_at>home_tunnel_now()",
              [next.identity.endpoint.id, next.identity.endpoint.id],
            );
            for (const pairing of pairings) await sendPairing(pairing.id);
            await changedPresence(next.identity.endpoint.owner_user_id);
            return;
          }
          await transaction((db) => rd.assertLiveIdentity(db, connection.identity!));
          await rd.accountSignalBytes(
            connection.identity.endpoint.owner_user_id,
            Buffer.byteLength(data as Buffer),
            0,
            reservedTypes.has(String(message.type)),
          );
          if (message.type === "ping") {
            z.strictObject({ v: z.literal(1), type: z.literal("ping") }).parse(message);

            await send(connection, { v: 1, type: "pong" });
            return;
          }
          if (message.type === "presence.subscribe") {
            z.strictObject({ v: z.literal(1), type: z.literal("presence.subscribe") }).parse(
              message,
            );

            connection.presenceSubscribed = true;
            await sendPresence(connection, true);
            return;
          }
          if (message.type === "session.close") {
            const command = z
              .strictObject({ v: z.literal(1), type: z.literal("session.close"), session_id: uuid })
              .parse(message);

            await rd.closeSession(
              connection.identity.endpoint.owner_user_id,
              command.session_id,
              "RD_CANCELLED",
              connection.identity.endpoint.id,
            );
            return;
          }
          if (message.type === "session.close_ack") {
            const command = z
              .strictObject({
                v: z.literal(1),
                type: z.literal("session.close_ack"),
                session_id: uuid,
                connection_epoch: z.number().int().positive(),
                lease_seq: z.number().int().min(0),
                signed_proof: z.string().max(8192),
              })
              .parse(message);

            await rd.closeAck(connection.identity, command.session_id, command);
            return;
          }
          if (message.type === "session.state") {
            const command = z
              .strictObject({
                v: z.literal(1),
                type: z.literal("session.state"),
                session_id: uuid,
                connection_epoch: z.number().int().positive(),
                phase: z.enum(["connecting", "ready", "failed"]),
                expected_version: z.number().int().positive(),
                path_verified: z.boolean().optional(),
                error_code: z
                  .enum([
                    "RD_NO_DIRECT_PATH",
                    "RD_MEDIA_FAILED",
                    "RD_PERMISSION_DENIED",
                    "RD_PEER_AUTH_FAILED",
                    "RD_CANCELLED",
                  ])
                  .optional(),
              })
              .parse(message);

            await rd.reportSession(connection.identity, command.session_id, command);
            return;
          }
          await forwardPeer(connection, message);
        })
        .catch(async (error) => {
          const code = error instanceof HttpError ? error.errorCode : "RD_SIGNAL_INVALID";
          await send(connection, {
            v: 1,
            type: "error",
            error_code: code,
            message: "信令消息被拒绝",
          }).catch(() => undefined);
          if (
            !connection.identity ||
            [
              "RD_PROOF_INVALID",
              "RD_PROOF_REPLAY",
              "RD_RATE_LIMITED",
              "RD_SIGNAL_BUDGET",
              "RD_AUTH_REVOKED",
            ].includes(code)
          )
            socket.close(1008, "invalid signaling");
        })
        .finally(() => {
          connection.pending--;
        });
    });
  });
  const onSession = (id: string) => {
    void sendSession(id).catch(() => undefined);
  };
  const onPairing = (id: string) => {
    void sendPairing(id).catch(() => undefined);
  };
  const onPresence = (owner: string) => {
    void changedPresence(owner).catch(() => undefined);
  };
  rd.rdEvents.on("session", onSession);
  rd.rdEvents.on("pairing", onPairing);
  rd.rdEvents.on("presence", onPresence);
  let sweeping = false;
  const sweep = setInterval(() => {
    if (sweeping || !rdConfig.enabled) return;
    sweeping = true;
    void (async () => {
      await transaction(rd.cleanupRd);
      // Deliver stop notices before disconnecting newly revoked control identities.
      const sessions = await query<{ id: string }>(
        "SELECT id FROM rd_sessions WHERE state NOT IN ('closed','failed','expired') ORDER BY updated_at DESC LIMIT 200",
      );
      for (const session of sessions) await sendSession(session.id);
      for (const connection of all) {
        if (!connection.identity) continue;
        try {
          await transaction((db) => rd.assertLiveIdentity(db, connection.identity!));
        } catch {
          connection.socket.close(4003, "authorization revoked");
          continue;
        }
        if (Date.now() >= connection.identity.expiresAt) {
          connection.socket.close(4003, "authorization expired");
          continue;
        }
        if (!connection.sentReauth && Date.now() + 120000 >= connection.identity.expiresAt) {
          connection.sentReauth = true;
          await send(connection, {
            v: 1,
            type: "auth.reauth_required",
            connection_id: connection.id,
            nonce: connection.nonce,
          });
        }
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        sweeping = false;
      });
  }, 1000);
  sweep.unref();
  const heartbeat = setInterval(() => {
    for (const connection of all) {
      if (!connection.alive) connection.socket.terminate();
      else {
        connection.alive = false;
        connection.socket.ping();
      }
    }
  }, 60000);
  heartbeat.unref();
  return {
    close: async () => {
      stopping = true;
      unregister();
      clearInterval(sweep);
      clearInterval(heartbeat);
      rd.rdEvents.off("session", onSession);
      rd.rdEvents.off("pairing", onPairing);
      rd.rdEvents.off("presence", onPresence);
      for (const connection of all) connection.socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
