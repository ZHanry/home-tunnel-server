import { Router } from "express";
import { z } from "zod";
import { query, transaction } from "../db.js";
import { asyncHandler, HttpError, requireCsrf, requirePasswordNormal } from "../http.js";
import { parseBody } from "../validation.js";
import { homedeskConfig, normalizeIdServer } from "../homedesk.js";
import { deviceSessionLive } from "../account-session.js";
import { permitTrust, verifyBindingProof } from "../remote-permit.js";

const router = Router();
router.get(
  "/homedesk/config",
  asyncHandler(async (request, response) => {
    requirePasswordNormal(request);
    response.setHeader("cache-control", "no-store");
    response.json(
      request.baseUrl === "/api/v2"
        ? { ...homedeskConfig, permit_trust: permitTrust }
        : homedeskConfig,
    );
  }),
);

router.get(
  "/homedesk/devices",
  asyncHandler(async (request, response) => {
    const actor = requirePasswordNormal(request);
    if (actor.deviceId)
      throw new HttpError(403, "ACCOUNT_SESSION_REQUIRED", "请使用账号管理会话读取设备目录");
    const rows = await query<{
      device_id: string;
      remote_id: string;
      server: string;
      key_sha256: string;
      platform: string;
      last_seen: Date | string;
      online_v2: boolean;
    }>(
      `SELECT b.*, EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.device_id=d.id AND s.client_type='device' AND s.revoked_at IS NULL
        AND s.refresh_expires_at>home_tunnel_now() AND s.token_version=u.token_version
        AND u.status='active' AND u.password_state='normal' AND ${deviceSessionLive}
        AND d.credential_purpose='gui' AND b.remote_public_key<>'') AS online_v2
      FROM homedesk_bindings b JOIN devices d ON d.id=b.device_id
      WHERE d.user_id=? AND d.status='active' AND d.revoked_at IS NULL
        AND b.server=? AND b.key_sha256=? ORDER BY d.name,b.device_id LIMIT 1000`,
      [actor.userId, homedeskConfig.server, homedeskConfig.key_sha256],
    );
    response.setHeader("cache-control", "no-store");
    response.json({
      items: rows.map((row) => ({
        ...row,
        online:
          Date.now() - new Date(row.last_seen).getTime() < 90_000 &&
          (request.baseUrl !== "/api/v2" || Boolean(row.online_v2)),
      })),
      version: request.baseUrl === "/api/v2" ? 2 : 1,
    });
  }),
);

router.put(
  "/homedesk/devices/current",
  asyncHandler(async (request, response) => {
    const actor = requirePasswordNormal(request);
    requireCsrf(request);
    if (!actor.deviceId)
      throw new HttpError(403, "DEVICE_SESSION_REQUIRED", "请使用当前设备会话登记远控 ID");
    const body = parseBody(
      z.strictObject({
        device_id: z.uuid(),
        remote_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
        server: z.string().min(1).max(259),
        key_sha256: z.string().regex(/^[a-f0-9]{64}$/),
        platform: z.enum(["windows", "linux", "macos", "android", "ios"]),
        remote_public_key: z
          .string()
          .regex(/^[A-Za-z0-9+/]{43}=$/)
          .optional(),
        remote_proof: z
          .string()
          .regex(/^[A-Za-z0-9+/]{86}==$/)
          .optional(),
      }),
      request.body,
    );
    if (body.device_id !== actor.deviceId)
      throw new HttpError(403, "DEVICE_SCOPE", "只能登记当前设备");
    if (
      request.baseUrl === "/api/v2" &&
      (!body.remote_public_key ||
        !body.remote_proof ||
        !verifyBindingProof(
          actor.deviceId,
          body.remote_id,
          body.remote_public_key,
          body.remote_proof,
        ))
    )
      throw new HttpError(403, "REMOTE_PROOF_INVALID", "设备身份签名无效");
    if (!homedeskConfig.configured)
      throw new HttpError(503, "HOMEDESK_UNCONFIGURED", "管理员尚未配置 hbbs 信令服务器与公钥");
    if (
      normalizeIdServer(body.server) !== homedeskConfig.server ||
      body.key_sha256 !== homedeskConfig.key_sha256
    ) {
      throw new HttpError(400, "HOMEDESK_REALM_MISMATCH", "远控服务器或公钥指纹与当前部署不一致");
    }
    await transaction(async (client) => {
      const session = await client.query(
        `SELECT s.id FROM sessions s JOIN users u ON u.id=s.user_id
      JOIN devices d ON d.id=s.device_id AND d.user_id=s.user_id
      WHERE s.id=? AND s.user_id=? AND s.device_id=? AND s.revoked_at IS NULL
        AND s.access_expires_at>home_tunnel_now() AND s.token_version=u.token_version
        AND u.status='active' AND u.password_state='normal'
        AND d.status='active' AND d.revoked_at IS NULL AND ${deviceSessionLive}`,
        [actor.sessionId, actor.userId, actor.deviceId],
      );
      if (!session.rows[0]) throw new HttpError(423, "DEVICE_REVOKED", "设备或会话已撤销");
      const duplicate = await client.query(
        `SELECT device_id FROM homedesk_bindings
      WHERE server=? AND key_sha256=? AND remote_id=? AND device_id<>?`,
        [homedeskConfig.server, body.key_sha256, body.remote_id, actor.deviceId],
      );
      if (duplicate.rows[0])
        throw new HttpError(409, "REMOTE_ID_CONFLICT", "此远控 ID 已登记在其他设备");
      await client.query(
        `INSERT INTO homedesk_bindings(device_id,remote_id,server,key_sha256,platform,remote_public_key,last_seen)
      VALUES(?,?,?,?,?,?,home_tunnel_now()) ON CONFLICT(device_id) DO UPDATE SET
      remote_id=excluded.remote_id,server=excluded.server,key_sha256=excluded.key_sha256,
      platform=excluded.platform,remote_public_key=excluded.remote_public_key,last_seen=excluded.last_seen`,
        [
          actor.deviceId,
          body.remote_id,
          homedeskConfig.server,
          body.key_sha256,
          body.platform,
          body.remote_public_key ?? "",
        ],
      );
      await client.query(
        "UPDATE devices SET last_seen_at=home_tunnel_now(),updated_at=home_tunnel_now() WHERE id=?",
        [actor.deviceId],
      );
    });
    response.json({ device_id: actor.deviceId, registered: true });
  }),
);
export { router as homedeskRouter };
