import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { asyncHandler, HttpError, requireAdmin, requirePasswordNormal } from "../http.js";
import { parseBody } from "../validation.js";

const router = Router();

// This is a read-only administrative directory. It cannot link or revoke
// another account's subjects through the account management routes.
router.get(
  "/device-capabilities",
  asyncHandler(async (request, response) => {
    const actor = requireAdmin(request);
    requirePasswordNormal(request);
    if (actor.nativeRemote)
      throw new HttpError(403, "ACCOUNT_SESSION_REQUIRED", "请使用账号管理会话查看设备能力");
    const { user_id: userId } = parseBody(
      z.object({ user_id: z.uuid().optional() }),
      request.query,
    );
    const items = await query<{
      user_id: string;
      physical_device_id: string;
      remote_device_id: string | null;
      tunnel_device_id: string | null;
    }>(
      `SELECT link.user_id,link.remote_device_id AS physical_device_id,
        remote.id AS remote_device_id,tunnel.id AS tunnel_device_id
        FROM device_capability_links link
        JOIN users owner ON owner.id=link.user_id AND owner.deleted_at IS NULL
        JOIN devices remote ON remote.id=link.remote_device_id AND remote.user_id=link.user_id
          AND remote.credential_purpose='gui'
        JOIN devices tunnel ON tunnel.id=link.tunnel_device_id AND tunnel.user_id=link.user_id
          AND tunnel.credential_purpose='background'
        WHERE (? IS NULL OR link.user_id=?)
        ORDER BY link.user_id,link.remote_device_id`,
      [userId ?? null, userId ?? null],
    );
    response.setHeader("cache-control", "no-store");
    response.json({ version: 1, items });
  }),
);

export { router as adminDeviceCapabilitiesRouter };
