import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { transaction } from "../db.js";
import {
  asyncHandler,
  audit,
  HttpError,
  issueSession,
  pathParam,
  requireCsrf,
  requirePasswordNormal,
} from "../http.js";
import { opaqueToken, tokenHash } from "../security.js";
import { parseBody } from "../validation.js";

const router = Router();

// Management credentials and background credentials are never interchangeable.
router.post(
  "/devices",
  asyncHandler(async (request, response) => {
    const actor = requirePasswordNormal(request);
    requireCsrf(request);
    if (actor.deviceId || actor.nativeRemote)
      throw new HttpError(403, "ACCOUNT_SESSION_REQUIRED", "请使用账号登录登记设备");
    const body = parseBody(
      z.strictObject({
        name: z.string().trim().min(1).max(120),
        install_id: z.string().min(8).max(128),
        fingerprint_hash: z.string().regex(/^[a-f0-9]{64}$/i),
        client_version: z.string().min(1).max(64),
        client_type: z.enum(["windows", "macos", "linux", "android", "cli", "nas"]),
        credential_purpose: z.enum(["gui", "background"]),
      }),
      request.body,
    );
    if (body.credential_purpose === "gui" && ["cli", "nas"].includes(body.client_type))
      throw new HttpError(400, "VALIDATION_ERROR", "CLI 与 NAS 使用独立后台设备凭据");
    const credential = opaqueToken(48);
    const result = await transaction(async (client) => {
      const owner = (
        await client.query<{ token_version: number }>(
          `SELECT u.token_version FROM users u JOIN sessions s ON s.user_id=u.id
          WHERE u.id=? AND u.status='active' AND u.password_state='normal'
            AND u.deleted_at IS NULL AND s.id=? AND s.device_id IS NULL
            AND s.revoked_at IS NULL AND s.access_expires_at>home_tunnel_now()
            AND s.token_version=u.token_version`,
          [actor.userId, actor.sessionId],
        )
      ).rows[0];
      if (!owner) throw new HttpError(401, "SESSION_REVOKED", "账号登录已失效");
      const existing = (
        await client.query<{ id: string }>(
          `SELECT id FROM devices WHERE user_id=? AND credential_purpose=?
            AND fingerprint_hash=? AND revoked_at IS NULL`,
          [actor.userId, body.credential_purpose, body.fingerprint_hash.toLowerCase()],
        )
      ).rows[0];
      if (existing && body.credential_purpose === "background")
        throw new HttpError(409, "DEVICE_ALREADY_REGISTERED", "请使用已有后台设备凭据");
      const deviceId = existing?.id ?? randomUUID();
      if (existing) {
        await client.query(
          "UPDATE sessions SET revoked_at=COALESCE(revoked_at,home_tunnel_now()) WHERE device_id=?",
          [deviceId],
        );
        await client.query(
          `UPDATE devices SET credential_hash=?,name=?,client_version=?,
          last_seen_at=home_tunnel_now(),updated_at=home_tunnel_now() WHERE id=?`,
          [tokenHash(credential), body.name, body.client_version, deviceId],
        );
      } else {
        const count = (
          await client.query<{ count: number }>(
            "SELECT count(*) AS count FROM devices WHERE user_id=? AND revoked_at IS NULL",
            [actor.userId],
          )
        ).rows[0];
        if (Number(count?.count ?? 0) >= 1000)
          throw new HttpError(409, "RESOURCE_LIMIT", "账号设备数已达上限");
        await client.query(
          `INSERT INTO devices(id,user_id,name,install_id,fingerprint_hash,credential_hash,
          client_version,credential_purpose,last_seen_at)
          VALUES(?,?,?,?,?,?,?,?,home_tunnel_now())`,
          [
            deviceId,
            actor.userId,
            body.name,
            body.install_id,
            body.fingerprint_hash.toLowerCase(),
            tokenHash(credential),
            body.client_version,
            body.credential_purpose,
          ],
        );
      }
      const session = await issueSession(
        client,
        { id: actor.userId, token_version: owner.token_version },
        deviceId,
        "device",
        request.header("user-agent"),
      );
      if (body.credential_purpose === "gui")
        await client.query("UPDATE sessions SET management_parent_session_id=? WHERE id=?", [
          actor.sessionId,
          session.sessionId,
        ]);
      await audit(client, request, "DeviceRegisteredWithAccount", "Device", deviceId, null, {
        credential_purpose: body.credential_purpose,
        renewed: Boolean(existing),
      });
      return { deviceId, session };
    });
    response.setHeader("cache-control", "no-store");
    response.status(201).json({
      device_id: result.deviceId,
      device_credential: credential,
      credential_purpose: body.credential_purpose,
      name: body.name,
      config_version: 1,
      access_token: result.session.accessToken,
      refresh_token: result.session.refreshToken,
      csrf_token: result.session.csrfToken,
      access_expires_at: result.session.accessExpiresAt,
      refresh_expires_at: result.session.refreshExpiresAt,
    });
  }),
);

export { router as accountDevicesRouter };

router.delete(
  "/devices/:id",
  asyncHandler(async (request, response) => {
    const actor = requirePasswordNormal(request);
    requireCsrf(request);
    if (actor.deviceId || actor.nativeRemote)
      throw new HttpError(403, "ACCOUNT_SESSION_REQUIRED", "请使用账号管理会话撤销设备");
    const id = pathParam(request, "id");
    await transaction(async (client) => {
      const result = await client.query<{ config_version: number }>(
        `UPDATE devices SET status='revoked',revoked_at=COALESCE(revoked_at,home_tunnel_now()),
        lease_expires_at=home_tunnel_now(),config_version=config_version+1,updated_at=home_tunnel_now()
        WHERE id=? AND user_id=? RETURNING config_version`,
        [id, actor.userId],
      );
      if (!result.rows[0]) throw new HttpError(404, "NOT_FOUND", "设备不存在");
      await client.query(
        "UPDATE sessions SET revoked_at=COALESCE(revoked_at,home_tunnel_now()) WHERE device_id=?",
        [id],
      );
      await client.query(
        `INSERT INTO outbox_events(event_type,resource_type,resource_id,resource_version,recipient_user_id,recipient_device_id,payload)
        VALUES('subject.revoked','Device',?,?,?,?,?)`,
        [
          id,
          result.rows[0].config_version,
          actor.userId,
          id,
          JSON.stringify({ subject_type: "device", subject_id: id }),
        ],
      );
      await audit(client, request, "DeviceRevoked", "Device", id, null, null);
    });
    response.status(204).end();
  }),
);
