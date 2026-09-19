import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { query, transaction } from "../db.js";
import { publicConnection, updateConnection } from "../domain.js";
import {
  asyncHandler,
  audit,
  HttpError,
  issueSession,
  pathParam,
  requireAdmin,
  requireCsrf,
  requirePasswordNormal,
} from "../http.js";
import { FixedWindowLimiter, opaqueToken, tokenHash } from "../security.js";
import { parseBody } from "../validation.js";
import type { AuthenticatedRequest } from "../types.js";

const router = Router();
const enrollmentLimiter = new FixedWindowLimiter(10, 60_000);
function manager(request: AuthenticatedRequest) {
  const actor = requirePasswordNormal(request);
  requireCsrf(request);
  if (actor.deviceId) throw new HttpError(403, "FORBIDDEN", "请使用账号管理会话生成接入码");
  return actor;
}

router.post(
  "/client/enrollment-codes",
  asyncHandler(async (request, response) => {
    const actor = manager(request);
    const body = parseBody(z.object({ name: z.string().trim().min(1).max(120) }), request.body);
    const code = opaqueToken(24),
      id = randomUUID(),
      expiresAt = new Date(Date.now() + 10 * 60_000);
    await transaction(async (client) => {
      const active = (
        await client.query<{ count: number }>(
          "SELECT count(*) AS count FROM enrollment_codes WHERE user_id=? AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at>home_tunnel_now()",
          [actor.userId],
        )
      ).rows[0];
      if (Number(active?.count ?? 0) >= 10)
        throw new HttpError(429, "RESOURCE_LIMIT", "最多同时保留 10 个有效接入码，请撤销旧码");
      await client.query(
        "INSERT INTO enrollment_codes(id,user_id,code_hash,name,expires_at) VALUES(?,?,?,?,?)",
        [id, actor.userId, tokenHash(code), body.name, expiresAt],
      );
      await audit(client, request, "EnrollmentCodeCreated", "EnrollmentCode", id, null, {
        name: body.name,
        expires_at: expiresAt,
      });
    });
    response.setHeader("cache-control", "no-store");
    response.status(201).json({ id, code, name: body.name, expires_at: expiresAt });
  }),
);

router.get(
  "/client/enrollment-codes",
  asyncHandler(async (request, response) => {
    const actor = manager(request);
    const items = await query(
      "SELECT id,name,created_at,expires_at,consumed_at,revoked_at FROM enrollment_codes WHERE user_id=? AND expires_at>home_tunnel_now() ORDER BY created_at DESC LIMIT 100",
      [actor.userId],
    );
    response.json({ items });
  }),
);

router.delete(
  "/client/enrollment-codes/:id",
  asyncHandler(async (request, response) => {
    const actor = manager(request),
      id = pathParam(request, "id");
    await transaction(async (client) => {
      const result = await client.query(
        "UPDATE enrollment_codes SET revoked_at=COALESCE(revoked_at,home_tunnel_now()) WHERE id=? AND user_id=? RETURNING id",
        [id, actor.userId],
      );
      if (!result.rowCount) throw new HttpError(404, "NOT_FOUND", "接入码不存在");
      await audit(client, request, "EnrollmentCodeRevoked", "EnrollmentCode", id, null, null);
    });
    response.status(204).end();
  }),
);

router.post(
  "/auth/enroll",
  asyncHandler(async (request, response) => {
    if (!enrollmentLimiter.take(request.ip ?? "unknown").allowed)
      throw new HttpError(429, "RATE_LIMITED", "接入码尝试过多，请稍后重试");
    const body = parseBody(
      z.object({
        code: z.string().min(24).max(128),
        name: z.string().trim().min(1).max(120),
        install_id: z.string().min(8).max(128),
        fingerprint_hash: z.string().regex(/^[a-f0-9]{64}$/i),
        client_version: z.string().max(64),
        client_type: z.enum(["windows", "linux", "macos"]),
      }),
      request.body,
    );
    const credential = opaqueToken(48),
      deviceId = randomUUID();
    const session = await transaction(async (client) => {
      const code = (
        await client.query<{ id: string; user_id: string; token_version: number }>(
          `SELECT e.id,e.user_id,u.token_version FROM enrollment_codes e JOIN users u ON u.id=e.user_id
      WHERE e.code_hash=? AND e.consumed_at IS NULL AND e.revoked_at IS NULL AND e.expires_at>home_tunnel_now()
      AND u.status='active' AND u.password_state='normal' AND u.deleted_at IS NULL`,
          [tokenHash(body.code)],
        )
      ).rows[0];
      if (!code) throw new HttpError(401, "ENROLLMENT_INVALID", "接入码无效、已使用或已过期");
      const existing = await client.query(
        "SELECT id FROM devices WHERE user_id=? AND fingerprint_hash=? AND revoked_at IS NULL",
        [code.user_id, body.fingerprint_hash.toLowerCase()],
      );
      if (existing.rowCount)
        throw new HttpError(
          409,
          "DEVICE_ALREADY_ENROLLED",
          "此设备已登记，请使用已有设备凭据或先撤销旧设备",
        );
      const count = (
        await client.query<{ count: number }>(
          "SELECT count(*) AS count FROM devices WHERE user_id=? AND revoked_at IS NULL",
          [code.user_id],
        )
      ).rows[0];
      if (Number(count?.count ?? 0) >= 1000)
        throw new HttpError(409, "RESOURCE_LIMIT", "账号设备数已达上限");
      await client.query("UPDATE enrollment_codes SET consumed_at=home_tunnel_now() WHERE id=?", [
        code.id,
      ]);
      await client.query(
        "INSERT INTO devices(id,user_id,name,install_id,fingerprint_hash,credential_hash,client_version,last_seen_at) VALUES(?,?,?,?,?,?,?,home_tunnel_now())",
        [
          deviceId,
          code.user_id,
          body.name,
          body.install_id,
          body.fingerprint_hash.toLowerCase(),
          tokenHash(credential),
          body.client_version,
        ],
      );
      const session = await issueSession(
        client,
        { id: code.user_id, token_version: code.token_version },
        deviceId,
        body.client_type,
        request.header("user-agent"),
      );
      await audit(
        client,
        request,
        "DeviceEnrolledWithCode",
        "Device",
        deviceId,
        null,
        { enrollment_code_id: code.id },
        { type: "user", id: code.user_id },
      );
      return session;
    });
    response.setHeader("cache-control", "no-store");
    response.status(201).json({
      device_id: deviceId,
      device_credential: credential,
      name: body.name,
      config_version: 1,
      access_token: session.accessToken,
      refresh_token: session.refreshToken,
      csrf_token: session.csrfToken,
      access_expires_at: session.accessExpiresAt,
      refresh_expires_at: session.refreshExpiresAt,
    });
  }),
);

router.patch(
  ["/client/devices/:id/metadata", "/admin/devices/:id/metadata"],
  asyncHandler(async (request, response) => {
    const actor = requirePasswordNormal(request);
    requireCsrf(request);
    const owner = request.path.startsWith("/admin/") ? (requireAdmin(request), null) : actor.userId;
    const id = pathParam(request, "id");
    if (actor.deviceId && actor.deviceId !== id)
      throw new HttpError(404, "OWNERSHIP_MISMATCH", "设备不存在");
    const body = parseBody(
      z.object({
        tags: z.array(z.string().trim().min(1).max(32)).max(12),
        favorite: z.boolean(),
        expected_metadata_version: z.number().int().positive(),
      }),
      request.body,
    );
    const tags = [...new Set(body.tags)].sort();
    const updated = await transaction(async (client) => {
      const result = await client.query(
        "UPDATE devices SET tags=?,favorite=?,metadata_version=metadata_version+1,updated_at=home_tunnel_now() WHERE id=? AND (? IS NULL OR user_id=?) AND metadata_version=? AND revoked_at IS NULL RETURNING metadata_version",
        [JSON.stringify(tags), body.favorite, id, owner, owner, body.expected_metadata_version],
      );
      if (!result.rows[0])
        throw new HttpError(409, "VERSION_CONFLICT", "设备标签已变更或设备不存在，请刷新后重试");
      await audit(client, request, "DeviceMetadataChanged", "Device", id, null, {
        tags,
        favorite: body.favorite,
      });
      return result.rows[0];
    });
    response.json({ id, tags, favorite: body.favorite, ...updated });
  }),
);

router.post(
  ["/client/connections/batch", "/admin/connections/batch"],
  asyncHandler(async (request, response) => {
    const actor = requirePasswordNormal(request);
    requireCsrf(request);
    const admin = request.path.startsWith("/admin/");
    if (admin) requireAdmin(request);
    const body = parseBody(
      z.object({
        enabled: z.boolean(),
        items: z
          .array(z.object({ id: z.string().uuid(), expected_version: z.number().int().positive() }))
          .min(1)
          .max(50),
      }),
      request.body,
    );
    if (new Set(body.items.map((item) => item.id)).size !== body.items.length)
      throw new HttpError(400, "VALIDATION_ERROR", "批量操作不能包含重复连接");
    const results = [];
    for (const item of body.items) {
      try {
        const after = await transaction(async (client) => {
          if (actor.deviceId) {
            const owned = (
              await client.query(
                "SELECT id FROM connections WHERE id=? AND user_id=? AND device_id=? AND deleted_at IS NULL",
                [item.id, actor.userId, actor.deviceId],
              )
            ).rows[0];
            if (!owned) throw new HttpError(404, "OWNERSHIP_MISMATCH", "连接不存在");
          }
          const changed = await updateConnection(
            client,
            item.id,
            item.expected_version,
            { enabled: body.enabled },
            admin ? undefined : actor.userId,
          );
          await audit(
            client,
            request,
            "ConnectionBatchStateChanged",
            "Connection",
            item.id,
            { enabled: changed.before.enabled },
            { enabled: body.enabled },
          );
          return changed.after;
        });
        results.push({ id: item.id, status: 200, connection: publicConnection(after) });
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        results.push({
          id: item.id,
          status: error.status,
          error_code: error.errorCode,
          message: error.message,
          ...error.details,
        });
      }
    }
    response.json({ results });
  }),
);

export { router as platformRouter };
