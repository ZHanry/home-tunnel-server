import { raw, Router, type RequestHandler } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { one, query, transaction } from "../db.js";
import {
  asyncHandler,
  authenticate,
  HttpError,
  pathParam,
  requireAdmin,
  requireCsrf,
  requirePasswordNormal,
} from "../http.js";
import { verifyMfa } from "../mfa.js";
import { FixedWindowLimiter, verifyPassword } from "../security.js";
import type { AuthenticatedRequest } from "../types.js";
import { parseBody, uuid } from "../validation.js";
import { authenticateRd } from "../rd/auth.js";
import { publicJwk, strictJson } from "../rd/crypto.js";
import * as rd from "../rd/service.js";

type Request = AuthenticatedRequest & { rdIdentity?: rd.RdIdentity; rdBodyBytes?: number };
const router = Router(),
  admin = Router();
const string = z.string().min(1).max(128),
  signature = z.string().min(1).max(16000),
  nonce = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const scopes = z
  .array(z.enum(rd.permissions))
  .min(1)
  .max(rd.permissions.length)
  .refine((values) => new Set(values).size === values.length && values.includes("view"));
const requestLimiter = new FixedWindowLimiter(120, 60000),
  challengeLimiter = new FixedWindowLimiter(10, 60000),
  sessionMinute = new FixedWindowLimiter(5, 60000),
  sessionHour = new FixedWindowLimiter(30, 3600000),
  reauthLimiter = new FixedWindowLimiter(8, 600000);
const rawParser = raw({ limit: 16 * 1024, type: "application/json" });
const parser: RequestHandler = (request, response, next) => {
  rawParser(request, response, (error: unknown) => {
    if (error) {
      const oversized = (error as { type?: string }).type === "entity.too.large";
      next(
        new HttpError(
          oversized ? 413 : 400,
          oversized ? "RD_BODY_TOO_LARGE" : "RD_JSON_INVALID",
          "远程桌面请求体过大或编码无效",
        ),
      );
      return;
    }
    try {
      const rawBody: unknown = request.body;
      if (Buffer.isBuffer(rawBody)) {
        const bytes = Uint8Array.from(rawBody);
        (request as Request).rdBodyBytes = bytes.byteLength;
        const parsed = strictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("JSON object required");
        request.body = parsed;
      } else if (rawBody !== undefined) throw new Error("Raw JSON body required");
      next();
    } catch {
      next(new HttpError(400, "RD_JSON_INVALID", "JSON 编码、字段或数值无效"));
    }
  });
};
const guard: RequestHandler = asyncHandler(async (request, response, next) => {
  // Revocation and fresh account verification remain reachable after policy shutdown.
  if (
    request.path !== "/reauth" &&
    !request.path.endsWith("/close") &&
    !request.path.endsWith("/close-ack") &&
    request.method !== "DELETE"
  )
    await rd.requireEnabled();
  const result = requestLimiter.take(request.ip ?? "unknown");
  if (!result.allowed) {
    response.setHeader("retry-after", String(result.retryAfterSeconds));
    throw new HttpError(429, "RD_RATE_LIMITED", "远程桌面请求过多");
  }
  next();
});
router.use(guard, parser);
admin.use(parser, authenticate);
router.use((request: Request, response, next) => {
  if ((request.header("authorization") ?? "").startsWith("DPoP ")) {
    void authenticateRd(request)
      .then((identity) => {
        request.rdIdentity = identity;
        next();
      })
      .catch(next);
  } else authenticate(request, response, next);
});
const byteBudget: RequestHandler = asyncHandler(async (request: Request, response, next) => {
  const owner = request.rdIdentity?.endpoint.owner_user_id ?? request.actor?.userId;
  if (!owner) {
    next();
    return;
  }
  const reserved =
    request.method === "DELETE" ||
    /\/(?:close|close-ack|reauth|revoke|renew|tokens|signal-tickets|policy)$/.test(request.path);
  await rd.accountSignalBytes(owner, request.rdBodyBytes ?? 0, 0, reserved);
  const originalSend = response.send.bind(response);
  let accounted = false;
  response.send = (body?: unknown) => {
    if (accounted) return originalSend(body);
    accounted = true;
    const bytes = Buffer.isBuffer(body)
      ? body.length
      : Buffer.byteLength(typeof body === "string" ? body : (JSON.stringify(body) ?? ""));
    void rd
      .accountSignalBytes(owner, 0, bytes, reserved)
      .then(() => {
        originalSend(body);
      })
      .catch(next);
    return response;
  };
  next();
});
router.use(byteBudget);
admin.use(byteBudget);
function account(request: Request) {
  const actor = requirePasswordNormal(request);
  requireCsrf(request);
  if (actor.deviceId) rd.fail(403, "RD_ACCOUNT_REQUIRED", "需要账号管理身份");
  if (
    actor.authSource === "cookie" &&
    !["GET", "HEAD"].includes(request.method) &&
    request.header("origin") !== new URL(config.publicBaseUrl).origin
  )
    rd.fail(403, "RD_ORIGIN_INVALID", "页面来源不匹配");
  return actor;
}
function identity(request: Request) {
  if (!request.rdIdentity) rd.fail(401, "RD_AUTH_REQUIRED", "需要远程桌面端点身份");
  return request.rdIdentity;
}
function viewer(request: Request) {
  const current = request.rdIdentity;
  return { owner: current?.endpoint.owner_user_id ?? account(request).userId, identity: current };
}
function page(request: Request) {
  return parseBody(
    z.strictObject({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).max(100000).default(0),
    }),
    request.query,
  );
}
function idempotency(request: Request) {
  return parseBody(
    z
      .string()
      .min(16)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
    request.header("idempotency-key"),
  );
}
function limitChallenge(request: Request) {
  if (!challengeLimiter.take(request.ip ?? "unknown").allowed)
    rd.fail(429, "RD_RATE_LIMITED", "挑战请求过多");
}
router.post(
  "/reauth",
  asyncHandler(async (request, response) => {
    const actor = account(request),
      body = parseBody(
        z.strictObject({
          password: z.string().min(1).max(256),
          mfa_code: z.string().max(128).optional(),
        }),
        request.body,
      );
    if (!reauthLimiter.take(`${request.ip}:${actor.userId}`).allowed)
      rd.fail(429, "RD_RATE_LIMITED", "验证尝试过多");
    await transaction(async (db) => {
      const user = (
        await db.query<{ password_hash: string; token_version: number }>(
          "SELECT password_hash,token_version FROM users WHERE id=?",
          [actor.userId],
        )
      ).rows[0];
      if (
        !user ||
        user.token_version !== actor.tokenVersion ||
        !(await verifyPassword(user.password_hash, body.password))
      )
        rd.fail(401, "AUTH_INVALID", "账号验证失败");
      await verifyMfa(db, actor.userId, body.mfa_code);
      await db.query(
        "UPDATE sessions SET rd_verified_at=home_tunnel_now() WHERE id=? AND revoked_at IS NULL",
        [actor.sessionId],
      );
    });
    response.json({ verified_at: rd.nowIso(), expires_at: rd.afterSeconds(300) });
  }),
);
router.get(
  "/server-keys",
  asyncHandler(async (_request, response) => {
    response.json(await rd.keySet());
  }),
);
router.post(
  "/enrollment-challenges",
  asyncHandler(async (request, response) => {
    limitChallenge(request);
    const body = parseBody(
      z.strictObject({
        endpoint_kind: z.enum(["desktop", "android", "browser"]),
        role: z.enum(["host", "controller", "both"]),
        public_jwk: z.unknown().transform(publicJwk),
        linked_device_id: uuid.optional(),
      }),
      request.body,
    );
    response.status(201).json(await rd.enrollmentChallenge(account(request), body));
  }),
);
router.post(
  "/endpoints",
  asyncHandler(async (request, response) => {
    const body = parseBody(
      z.strictObject({
        challenge_id: uuid,
        signed_proof: signature,
        name: z.string().trim().min(1).max(80),
        platform: z.string().min(1).max(80),
      }),
      request.body,
    );
    response.status(201).json(await rd.enroll(account(request), body));
  }),
);
router.post(
  "/token-challenges",
  asyncHandler(async (request, response) => {
    limitChallenge(request);
    const body = parseBody(
      z.strictObject({ endpoint_id: uuid, purpose: z.enum(["host_online", "controller_refresh"]) }),
      request.body,
    );
    response
      .status(201)
      .json(
        await rd.tokenChallenge(
          body.endpoint_id,
          body.purpose,
          body.purpose === "controller_refresh" ? account(request) : undefined,
        ),
      );
  }),
);
router.post(
  "/tokens",
  asyncHandler(async (request, response) => {
    limitChallenge(request);
    const body = parseBody(
      z.strictObject({ endpoint_id: uuid, challenge_id: uuid, proof: signature }),
      request.body,
    );
    const result = await rd.refreshToken(body, request.actor ? account(request) : undefined);
    if (!request.actor && !(request as Request).rdIdentity) {
      const refreshed = await rd.tokenIdentity(result.token);
      await rd.accountSignalBytes(
        refreshed.endpoint.owner_user_id,
        (request as Request).rdBodyBytes ?? 0,
        Buffer.byteLength(JSON.stringify(result)),
        true,
      );
    }
    response.json(result);
  }),
);
router.get(
  "/endpoints",
  asyncHandler(async (request, response) => {
    const user = viewer(request),
      pagination = page(request);
    response.json(
      await rd.listEndpoints(user.owner, user.identity, pagination.limit, pagination.offset),
    );
  }),
);
router.get(
  "/endpoints/:id",
  asyncHandler(async (request, response) => {
    const user = viewer(request),
      id = pathParam(request, "id");
    if (user.identity?.purpose === "host_online" && user.identity.endpoint.id !== id)
      rd.fail(404, "RD_NOT_FOUND", "端点不存在");
    const endpoint = await one<rd.Endpoint>(
      "SELECT * FROM rd_endpoints WHERE id=? AND owner_user_id=?",
      [id, user.owner],
    );
    if (!endpoint) rd.fail(404, "RD_NOT_FOUND", "端点不存在");
    response.json(rd.endpointView(endpoint));
  }),
);
router.patch(
  "/endpoints/:id/metadata",
  asyncHandler(async (request, response) => {
    const user = viewer(request),
      id = pathParam(request, "id"),
      body = parseBody(
        z.strictObject({
          name: z.string().trim().min(1).max(80),
          expected_version: z.number().int().positive(),
        }),
        request.body,
      );
    if (user.identity && user.identity.endpoint.id !== id)
      rd.fail(403, "RD_SCOPE_DENIED", "端点身份只能修改自身名称");
    const changed = await query(
      "UPDATE rd_endpoints SET name=?,metadata_version=metadata_version+1,updated_at=home_tunnel_now() WHERE id=? AND owner_user_id=? AND metadata_version=? RETURNING id",
      [body.name, id, user.owner, body.expected_version],
    );
    if (!changed.length) rd.fail(409, "RD_VERSION_CONFLICT", "端点不存在或名称版本已变化");
    response.json({ id, name: body.name, metadata_version: body.expected_version + 1 });
  }),
);
router.put(
  "/endpoints/:id/capabilities",
  asyncHandler(async (request, response) => {
    const who = identity(request);
    if (pathParam(request, "id") !== who.endpoint.id) rd.fail(404, "RD_NOT_FOUND", "端点不存在");
    const body = parseBody(
      z.strictObject({
        local_enabled: z.boolean(),
        capability_version: z.number().int().positive(),
        capabilities: z.strictObject({
          permissions: scopes,
          unattended_enabled: z.boolean().default(false),
          displays: z
            .array(
              z.strictObject({
                id: string,
                name: z.string().max(128),
                width: z.number().int().min(1).max(32768),
                height: z.number().int().min(1).max(32768),
              }),
            )
            .max(16)
            .default([]),
          codecs: z
            .array(z.enum(["H264", "VP8", "AV1", "HEVC"]))
            .max(4)
            .default([]),
          status: z
            .enum(["ready", "locked", "permission_required", "unavailable"])
            .default("ready"),
        }),
        signed_proof: signature,
      }),
      request.body,
    );
    const result = await rd.updateCapabilities(who, body);
    rd.rdEvents.emit("presence", who.endpoint.owner_user_id);
    response.json(result);
  }),
);
router.delete(
  "/endpoints/:id",
  asyncHandler(async (request, response) => {
    const actor = account(request);
    await rd.recentAccount(actor);
    await query(
      "UPDATE rd_endpoints SET status='revoked',revoked_at=COALESCE(revoked_at,home_tunnel_now()),local_enabled=0 WHERE id=? AND owner_user_id=? AND status<>'revoked'",
      [pathParam(request, "id"), actor.userId],
    );
    response.status(204).end();
  }),
);
router.post(
  "/signal-tickets",
  asyncHandler(async (request, response) => {
    const body = parseBody(
      z.strictObject({ purpose: z.enum(["connect", "reauth"]).default("connect") }),
      request.body,
    );
    response.status(201).json(await rd.signalTicket(identity(request), body.purpose));
  }),
);
router.post(
  "/pairings",
  asyncHandler(async (request, response) => {
    const who = identity(request);
    limitChallenge(request);
    const body = parseBody(
      z.strictObject({
        host_endpoint_id: uuid,
        session_request_id: uuid,
        permissions: scopes,
        mode: z.enum(["one_session", "persistent"]).default("one_session"),
        nonce_controller: nonce,
      }),
      request.body,
    );
    const result = await rd.createPairing(who, body);
    rd.rdEvents.emit("pairing", result.id);
    response.status(201).json(result);
  }),
);
router.get(
  "/pairings/:id",
  asyncHandler(async (request, response) => {
    response.json(await rd.pairing(identity(request), pathParam(request, "id")));
  }),
);
router.post(
  "/pairings/:id/confirm",
  asyncHandler(async (request, response) => {
    const body = parseBody(
        z.strictObject({
          signed_proof: signature,
          nonce_host: nonce.optional(),
          grant_jws: signature.optional(),
        }),
        request.body,
      ),
      id = pathParam(request, "id");
    const result = await rd.confirmPairing(identity(request), id, body);
    rd.rdEvents.emit("pairing", id);
    response.json(result);
  }),
);
router.post(
  "/pairings/:id/reject",
  asyncHandler(async (request, response) => {
    const id = pathParam(request, "id");
    await rd.rejectPairing(identity(request), id);
    rd.rdEvents.emit("pairing", id);
    response.status(204).end();
  }),
);
router.get(
  "/grants",
  asyncHandler(async (request, response) => {
    const user = viewer(request),
      pagination = page(request),
      host = user.identity?.purpose === "host_online";
    const rows = await query(
      "SELECT * FROM rd_grants WHERE owner_user_id=?" +
        (host ? " AND host_endpoint_id=?" : "") +
        " ORDER BY created_at,id LIMIT ? OFFSET ?",
      host
        ? [user.owner, user.identity!.endpoint.id, pagination.limit, pagination.offset]
        : [user.owner, pagination.limit, pagination.offset],
    );
    response.json({
      items: rows.map((row) => ({
        id: row.id,
        host_endpoint_id: row.host_endpoint_id,
        controller_endpoint_id: row.controller_endpoint_id,
        status: row.status,
        mode: row.mode,
        grant_version: row.grant_version,
        permissions: JSON.parse(row.scope_json as string) as unknown,
        grant_jws: row.host_signature,
        expires_at: row.expires_at,
      })),
      ...pagination,
    });
  }),
);
router.put(
  "/grants/:id",
  asyncHandler(async (request, response) => {
    const body = parseBody(z.strictObject({ grant_jws: signature }), request.body);
    response.json(await rd.putGrant(identity(request), pathParam(request, "id"), body.grant_jws));
  }),
);
router.delete(
  "/grants/:id",
  asyncHandler(async (request, response) => {
    const user = viewer(request);
    if (user.identity) rd.requireHost(user.identity);
    await rd.revokeGrant(user.owner, pathParam(request, "id"), user.identity?.endpoint.id);
    response.status(204).end();
  }),
);
router.post(
  "/sessions",
  asyncHandler(async (request, response) => {
    const who = identity(request);
    if (
      !sessionMinute.take(who.endpoint.owner_user_id).allowed ||
      !sessionHour.take(who.endpoint.owner_user_id).allowed
    ) {
      response.setHeader("retry-after", "60");
      rd.fail(429, "RD_RATE_LIMITED", "会话请求过多");
    }
    const body = parseBody(
      z.strictObject({
        host_endpoint_id: uuid,
        grant_id: uuid,
        permissions: scopes,
        display_id: string,
        protocol: z.strictObject({ major: z.number().int(), minor: z.number().int() }),
        quality: z.enum(["balanced", "quality", "speed"]).optional(),
      }),
      request.body,
    );
    response.status(202).json(await rd.createSession(who, idempotency(request), body));
  }),
);
router.get(
  "/sessions",
  asyncHandler(async (request, response) => {
    const user = viewer(request),
      pagination = page(request),
      host = user.identity?.purpose === "host_online";
    const rows = await query<rd.Session>(
      "SELECT * FROM rd_sessions WHERE owner_user_id=?" +
        (host ? " AND host_endpoint_id=?" : "") +
        " ORDER BY created_at DESC,id LIMIT ? OFFSET ?",
      host
        ? [user.owner, user.identity!.endpoint.id, pagination.limit, pagination.offset]
        : [user.owner, pagination.limit, pagination.offset],
    );
    response.json({
      items: await Promise.all(rows.map((row) => rd.sessionView(row))),
      ...pagination,
    });
  }),
);
router.get(
  "/sessions/:id",
  asyncHandler(async (request, response) => {
    const user = viewer(request);
    response.json(
      await rd.getSession(user.owner, pathParam(request, "id"), user.identity?.endpoint.id),
    );
  }),
);
router.post(
  "/sessions/:id/decision",
  asyncHandler(async (request, response) => {
    const body = parseBody(
      z.strictObject({
        decision: z.enum(["accept", "reject"]),
        grant_version: z.number().int().positive(),
        permissions: scopes,
        expected_version: z.number().int().positive(),
        signed_proof: signature,
      }),
      request.body,
    );
    response.json(await rd.decideSession(identity(request), pathParam(request, "id"), body));
  }),
);
router.post(
  "/sessions/:id/report",
  asyncHandler(async (request, response) => {
    const body = parseBody(
      z.strictObject({
        phase: z.enum(["connecting", "ready", "failed"]),
        connection_epoch: z.number().int().positive(),
        expected_version: z.number().int().positive(),
        error_code: z
          .enum([
            "RD_NO_DIRECT_PATH",
            "RD_MEDIA_FAILED",
            "RD_PERMISSION_DENIED",
            "RD_PEER_AUTH_FAILED",
            "RD_CANCELLED",
          ])
          .optional(),
        path_verified: z.boolean().optional(),
      }),
      request.body,
    );
    response.json(await rd.reportSession(identity(request), pathParam(request, "id"), body));
  }),
);
router.post(
  "/sessions/:id/renew",
  asyncHandler(async (request, response) => {
    const body = parseBody(
      z.strictObject({
        current_epoch: z.number().int().positive(),
        last_lease_seq: z.number().int().positive(),
        signed_proof: signature,
      }),
      request.body,
    );
    response.json(await rd.renewSession(identity(request), pathParam(request, "id"), body));
  }),
);
router.post(
  "/sessions/:id/reconnect",
  asyncHandler(async (request, response) => {
    const body = parseBody(
      z.strictObject({
        expected_epoch: z.number().int().positive(),
        reason: z.enum(["network_changed", "ice_failed", "display_changed", "media_failed"]),
      }),
      request.body,
    );
    response
      .status(202)
      .json(
        await rd.reconnectSession(
          identity(request),
          pathParam(request, "id"),
          idempotency(request),
          body,
        ),
      );
  }),
);
router.post(
  "/sessions/:id/close",
  asyncHandler(async (request, response) => {
    const user = viewer(request);
    await rd.closeSession(
      user.owner,
      pathParam(request, "id"),
      "RD_CANCELLED",
      user.identity?.endpoint.id,
    );
    response.status(204).end();
  }),
);
router.post(
  "/sessions/:id/close-ack",
  asyncHandler(async (request, response) => {
    const body = parseBody(
      z.strictObject({
        connection_epoch: z.number().int().positive(),
        lease_seq: z.number().int().min(0),
        signed_proof: signature,
      }),
      request.body,
    );
    await rd.closeAck(identity(request), pathParam(request, "id"), body);
    response.status(204).end();
  }),
);
router.get(
  "/audit",
  asyncHandler(async (request, response) => {
    const actor = account(request),
      pagination = page(request);
    response.json({
      items: await query(
        "SELECT id,action,resource_id,created_at FROM rd_audit WHERE owner_user_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?",
        [actor.userId, pagination.limit, pagination.offset],
      ),
      ...pagination,
    });
  }),
);
const policySchema = z.strictObject({
  enabled: z.boolean(),
  sessions_per_user: z.number().int().min(1).max(32),
  sessions_per_controller: z.number().int().min(1).max(16),
});
admin.get(
  "/policy",
  asyncHandler(async (request, response) => {
    requireAdmin(request);
    const row = await one<{ policy_json: string; version: number }>(
      "SELECT * FROM rd_policy WHERE scope_type='global' AND scope_id='global'",
    );
    response.json({
      policy: row
        ? (JSON.parse(row.policy_json) as unknown)
        : { enabled: true, sessions_per_user: 4, sessions_per_controller: 4 },
      version: row?.version ?? 0,
      udp_only: true,
      allow_turn: false,
      allow_ice_tcp: false,
    });
  }),
);
admin.patch(
  "/policy",
  asyncHandler(async (request, response) => {
    const actor = account(request);
    requireAdmin(request);
    await rd.recentAccount(actor);
    const body = parseBody(
      z.strictObject({ policy: policySchema, expected_version: z.number().int().min(0) }),
      request.body,
    );
    await transaction(async (db) => {
      const user = (await db.query("SELECT mfa_secret FROM users WHERE id=?", [actor.userId]))
        .rows[0];
      if (!user?.mfa_secret) rd.fail(403, "RD_MFA_REQUIRED", "修改远程桌面策略需要 TOTP");
      const current = (
        await db.query<{ version: number }>(
          "SELECT version FROM rd_policy WHERE scope_type='global' AND scope_id='global'",
        )
      ).rows[0];
      if ((current?.version ?? 0) !== body.expected_version)
        rd.fail(409, "RD_VERSION_CONFLICT", "策略版本已变化");
      await db.query(
        "INSERT INTO rd_policy(scope_type,scope_id,policy_json,version,updated_at) VALUES('global','global',?,?,home_tunnel_now()) ON CONFLICT(scope_type,scope_id) DO UPDATE SET policy_json=excluded.policy_json,version=excluded.version,updated_at=excluded.updated_at",
        [JSON.stringify(body.policy), body.expected_version + 1],
      );
      await rd.audit(db, actor.userId, "PolicyUpdated", "global");
      if (!body.policy.enabled)
        await db.query(
          "UPDATE rd_sessions SET state='closing',state_version=state_version+1,close_reason='RD_DISABLED' WHERE state NOT IN ('closed','failed','expired','closing')",
        );
    });
    response.json({ policy: body.policy, version: body.expected_version + 1 });
  }),
);
admin.post(
  "/sessions/:id/revoke",
  asyncHandler(async (request, response) => {
    const actor = account(request);
    requireAdmin(request);
    await rd.closeSession(
      actor.userId,
      pathParam(request, "id"),
      "RD_ADMIN_REVOKED",
      undefined,
      true,
    );
    response.status(204).end();
  }),
);
for (const target of [router, admin])
  target.use((_request, response) => {
    response.status(404).json({ error_code: "RD_NOT_FOUND", message: "远程桌面接口不存在" });
  });
export { router as remoteDesktopRouter, admin as remoteDesktopAdminRouter };
