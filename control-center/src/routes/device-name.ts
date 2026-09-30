import { Router } from "express";
import { z } from "zod";
import { transaction } from "../db.js";
import { asyncHandler, audit, HttpError, requireCsrf, requirePasswordNormal } from "../http.js";
import { parseBody } from "../validation.js";

const router = Router();

router.patch(
  "/devices/current/name",
  asyncHandler(async (request, response) => {
    const actor = requirePasswordNormal(request);
    requireCsrf(request);
    if (actor.nativeRemote) throw new HttpError(403, "FORBIDDEN", "远程窗口会话不能修改设备名称");
    if (!actor.deviceId) throw new HttpError(403, "DEVICE_SESSION_REQUIRED", "请使用当前设备会话");
    const body = parseBody(
      z.strictObject({
        name: z
          .string()
          .trim()
          .min(1)
          .max(120)
          .refine((value) => !/\p{Cc}/u.test(value)),
      }),
      request.body,
    );
    await transaction(async (client) => {
      // Authentication and mutation are separated by asynchronous work. Check the
      // session again inside the same transaction so a sign-out cannot race it.
      const session = await client.query(
        `SELECT s.id FROM sessions s JOIN users u ON u.id=s.user_id
         WHERE s.id=? AND s.user_id=? AND s.device_id=? AND s.revoked_at IS NULL
           AND s.access_expires_at>home_tunnel_now() AND s.token_version=u.token_version
           AND u.status='active' AND u.password_state='normal'`,
        [actor.sessionId, actor.userId, actor.deviceId],
      );
      if (!session.rows[0]) throw new HttpError(401, "SESSION_REVOKED", "会话已过期或被撤销");
      const device = await client.query<{ name: string }>(
        "SELECT name FROM devices WHERE id=? AND user_id=? AND status='active' AND revoked_at IS NULL",
        [actor.deviceId, actor.userId],
      );
      if (!device.rows[0]) throw new HttpError(423, "DEVICE_REVOKED", "设备已撤销");
      await client.query(
        "UPDATE devices SET name=?,updated_at=home_tunnel_now() WHERE id=? AND user_id=? AND status='active' AND revoked_at IS NULL",
        [body.name, actor.deviceId, actor.userId],
      );
      // A desktop host is another view of this same computer. Keep its display
      // name aligned without changing controller aliases or remote permissions.
      await client.query(
        `UPDATE rd_endpoints SET name=?,metadata_version=metadata_version+1,updated_at=home_tunnel_now()
         WHERE linked_device_id=? AND owner_user_id=? AND role IN ('host','both')
           AND status='active' AND revoked_at IS NULL AND name<>?`,
        [body.name, actor.deviceId, actor.userId, body.name],
      );
      await audit(client, request, "DeviceRenamed", "Device", actor.deviceId, device.rows[0], {
        name: body.name,
      });
    });
    response.json({ device_id: actor.deviceId, device_name: body.name });
  }),
);

export { router as deviceNameRouter };
