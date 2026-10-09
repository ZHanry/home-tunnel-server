import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { one } from "../db.js";
import { deviceSessionLive } from "../account-session.js";
import { asyncHandler, HttpError, pathParam, requireCsrf, requirePasswordNormal } from "../http.js";
import { homedeskConfig } from "../homedesk.js";
import { permitTrust, signBrowserGrant } from "../remote-permit.js";
import { rdConfig } from "../rd/config.js";
import { browserSdp, browserSdpDigest } from "../browser-remote.js";
import { FixedWindowLimiter } from "../security.js";
import { parseBody } from "../validation.js";
import type { AuthenticatedActor } from "../types.js";

type Session = {
  id: string;
  controllerSession: string;
  controllerUser: string;
  controllerName: string;
  hostSession: string;
  hostDevice: string;
  hostUser: string;
  targetId: string;
  offer: string;
  answer: string;
  password: string;
  state: "pending" | "active" | "closed";
  created: number;
  hostSeen: number;
  controllerSeen: number;
  closed: number;
};
type Host = { session: string; seen: number };
const sessions = new Map<string, Session>();
const hosts = new Map<string, Host>();
const attempts = new FixedWindowLimiter(5, 600000);
const router = Router();
const sdpSchema = z.string().min(32).max(32768);
const empty = z.strictObject({});

async function liveSession(id: string, device?: string): Promise<boolean> {
  return !!(await one<{ id: string }>(
    `SELECT s.id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=?
     AND s.revoked_at IS NULL AND s.refresh_expires_at>home_tunnel_now()
     AND u.status='active' AND u.deleted_at IS NULL AND u.password_state='normal'
     AND s.token_version=u.token_version AND ${deviceSessionLive}
     ${device ? "AND s.device_id=? AND s.client_type='device'" : "AND s.device_id IS NULL"}`,
    device ? [id, device] : [id],
  ));
}
function close(session: Session) {
  session.state = "closed";
  session.password = "";
  session.offer = "";
  session.answer = "";
  session.closed ||= Date.now();
}
function sweep() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.state === "pending" && now - session.created > 30000) close(session);
    if (
      session.state === "active" &&
      (now - session.hostSeen > 15000 || now - session.controllerSeen > 15000)
    )
      close(session);
    if (session.state === "closed" && now - session.closed > 30000) sessions.delete(id);
  }
  for (const [id, host] of hosts) if (now - host.seen > 15000) hosts.delete(id);
}
async function getSession(actor: AuthenticatedActor, id: string) {
  sweep();
  const session = sessions.get(id);
  if (!session || ![session.hostSession, session.controllerSession].includes(actor.sessionId))
    throw new HttpError(404, "BROWSER_SESSION_UNKNOWN", "远控会话不存在");
  if (
    !(await liveSession(session.controllerSession)) ||
    !(await liveSession(session.hostSession, session.hostDevice))
  )
    close(session);
  return session;
}
function snapshot(session: Session) {
  return {
    session_id: session.id,
    state: session.state,
    target_id: session.targetId,
    answer: session.answer,
    policy: "require_direct",
    frame_protocol: "nestlink-jpeg-v1",
    grant:
      session.state === "active"
        ? signBrowserGrant({
            v: 1,
            typ: "NestLink-Browser",
            jti: session.id,
            realm: permitTrust.realm,
            host_device: session.hostDevice,
            host_session: session.hostSession,
            controller_session: session.controllerSession,
            offer_sha256: browserSdpDigest(session.offer),
            answer_sha256: browserSdpDigest(session.answer),
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 15,
            policy: "require_direct",
          })
        : "",
  };
}
router.use((_request, response, next) => {
  response.setHeader("cache-control", "no-store");
  next();
});
router.get(
  "/config",
  asyncHandler(async (request, response) => {
    requirePasswordNormal(request);
    response.json({
      ice_servers: rdConfig.stunUrls.length ? [{ urls: [...rdConfig.stunUrls] }] : [],
      policy: "require_direct",
      transport: "udp",
      frame_protocol: "nestlink-jpeg-v1",
    });
  }),
);

router.post(
  "/hosts/poll",
  asyncHandler(async (request, response) => {
    const actor = requirePasswordNormal(request);
    requireCsrf(request);
    parseBody(empty, request.body);
    sweep();
    if (!actor.deviceId || !(await liveSession(actor.sessionId, actor.deviceId)))
      throw new HttpError(403, "GUI_SESSION_REQUIRED", "请在桌面客户端登录账号");
    const device = await one<{ id: string; platform: string }>(
      "SELECT d.id,b.platform FROM devices d JOIN homedesk_bindings b ON b.device_id=d.id WHERE d.id=? AND d.credential_purpose='gui' AND d.status='active' AND b.server=? AND b.key_sha256=?",
      [actor.deviceId, homedeskConfig.server, homedeskConfig.key_sha256],
    );
    if (!device || !["windows", "linux"].includes(device.platform))
      throw new HttpError(403, "BROWSER_HOST_UNSUPPORTED", "此设备不支持浏览器被控");
    hosts.set(actor.deviceId, { session: actor.sessionId, seen: Date.now() });
    const items = [];
    for (const session of sessions.values()) {
      if (session.hostSession !== actor.sessionId || session.state !== "pending") continue;
      if (!(await liveSession(session.controllerSession))) {
        close(session);
        continue;
      }
      items.push({
        session_id: session.id,
        controller_name: session.controllerName,
        controller_user: session.controllerUser,
        offer: session.offer,
        password: session.password,
        expires_at: new Date(session.created + 30000).toISOString(),
      });
    }
    response.json({ items, stun_urls: [...rdConfig.stunUrls] });
  }),
);
router.post(
  "/hosts/stop",
  asyncHandler(async (request, response) => {
    const actor = requirePasswordNormal(request);
    requireCsrf(request);
    parseBody(empty, request.body);
    if (!actor.deviceId) throw new HttpError(403, "GUI_SESSION_REQUIRED", "请使用桌面设备会话");
    const host = hosts.get(actor.deviceId);
    if (host?.session === actor.sessionId) hosts.delete(actor.deviceId);
    for (const session of sessions.values())
      if (session.hostSession === actor.sessionId) close(session);
    response.json({ stopped: true });
  }),
);
router.post(
  "/sessions",
  asyncHandler(async (request, response) => {
    const actor = requirePasswordNormal(request);
    requireCsrf(request);
    if (actor.deviceId || actor.nativeRemote)
      throw new HttpError(403, "ACCOUNT_SESSION_REQUIRED", "请使用浏览器账号登录");
    const body = parseBody(
      z.strictObject({
        target_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
        offer: sdpSchema,
        password: z.string().max(128).default(""),
      }),
      request.body,
    );
    const offer = browserSdp(body.offer);
    sweep();
    const count = [...sessions.values()].filter(
      (s) => s.controllerSession === actor.sessionId && s.state !== "closed",
    ).length;
    if (count >= 4 || sessions.size >= 1024)
      throw new HttpError(429, "RESOURCE_LIMIT", "远控连接过多，请先结束已有会话");
    const attempt = attempts.take(`${actor.userId}:${body.target_id}`);
    if (!attempt.allowed)
      throw new HttpError(429, "BROWSER_RATE_LIMITED", "连接尝试过多，请稍后再试");
    const binding = await one<{ device_id: string; user_id: string }>(
      `SELECT d.id AS device_id,d.user_id FROM devices d JOIN homedesk_bindings b ON b.device_id=d.id
     WHERE b.remote_id=? AND b.server=? AND b.key_sha256=? AND b.last_seen>?
       AND d.status='active' AND d.revoked_at IS NULL AND d.credential_purpose='gui'`,
      [
        body.target_id,
        homedeskConfig.server,
        homedeskConfig.key_sha256,
        new Date(Date.now() - 90000),
      ],
    );
    const host = binding && hosts.get(binding.device_id);
    if (!binding || !host || !(await liveSession(host.session, binding.device_id)))
      throw new HttpError(
        404,
        "BROWSER_HOST_OFFLINE",
        "设备未就绪，请确认桌面客户端已登录并开启共享",
      );
    if (
      [...sessions.values()].some((s) => s.hostDevice === binding.device_id && s.state !== "closed")
    )
      throw new HttpError(409, "BROWSER_HOST_BUSY", "设备已有浏览器远控会话");
    const now = Date.now();
    const session: Session = {
      id: randomUUID(),
      controllerSession: actor.sessionId,
      controllerUser: actor.userId,
      controllerName:
        actor.displayName && actor.displayName !== actor.username
          ? `${actor.displayName} (${actor.username})`
          : actor.username,
      hostSession: host.session,
      hostDevice: binding.device_id,
      hostUser: binding.user_id,
      targetId: body.target_id,
      offer,
      answer: "",
      password: body.password,
      state: "pending",
      created: now,
      hostSeen: now,
      controllerSeen: now,
      closed: 0,
    };
    sessions.set(session.id, session);
    response.status(201).json(snapshot(session));
  }),
);
router.post(
  "/sessions/:id/decision",
  asyncHandler(async (request, response) => {
    const actor = requirePasswordNormal(request);
    requireCsrf(request);
    const body = parseBody(
      z.strictObject({ approve: z.boolean(), answer: sdpSchema.optional() }),
      request.body,
    );
    const session = await getSession(actor, pathParam(request, "id"));
    if (actor.sessionId !== session.hostSession || actor.deviceId !== session.hostDevice)
      throw new HttpError(403, "BROWSER_HOST_REQUIRED", "仅被控设备可批准连接");
    if (session.state !== "pending")
      throw new HttpError(409, "BROWSER_SESSION_STATE", "请求已结束或处理");
    if (!body.approve) close(session);
    else {
      if (!body.answer) throw new HttpError(400, "VALIDATION_ERROR", "缺少连接信息");
      session.answer = browserSdp(body.answer);
      session.password = "";
      session.state = "active";
      session.hostSeen = Date.now();
      session.controllerSeen = Date.now();
    }
    response.json(snapshot(session));
  }),
);
router.get(
  "/sessions/:id",
  asyncHandler(async (request, response) => {
    const actor = requirePasswordNormal(request);
    response.json(snapshot(await getSession(actor, pathParam(request, "id"))));
  }),
);
router.post(
  "/sessions/:id/heartbeat",
  asyncHandler(async (request, response) => {
    const actor = requirePasswordNormal(request);
    requireCsrf(request);
    parseBody(empty, request.body);
    const session = await getSession(actor, pathParam(request, "id"));
    if (session.state === "active") {
      if (actor.sessionId === session.hostSession) session.hostSeen = Date.now();
      else session.controllerSeen = Date.now();
    }
    response.json(snapshot(session));
  }),
);
router.delete(
  "/sessions/:id",
  asyncHandler(async (request, response) => {
    const actor = requirePasswordNormal(request);
    requireCsrf(request);
    close(await getSession(actor, pathParam(request, "id")));
    response.status(204).end();
  }),
);
export { router as browserRemoteRouter };
