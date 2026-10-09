import { Router } from "express";
import { z } from "zod";
import { transaction } from "../db.js";
import { publicConnection, updateConnection } from "../domain.js";
import {
  asyncHandler,
  audit,
  HttpError,
  pathParam,
  requireAdmin,
  requireCsrf,
  requirePasswordNormal,
} from "../http.js";
import { parseBody } from "../validation.js";

const router = Router();
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
