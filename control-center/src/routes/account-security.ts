import { Router } from "express";
import { query, transaction } from "../db.js";
import {
  asyncHandler,
  audit,
  clearSessionCookies,
  HttpError,
  pathParam,
  requireActor,
  requireCsrf,
  requirePasswordNormal,
} from "../http.js";
import { sessionCsrf } from "../protected-secrets.js";
import { tokenHash } from "../security.js";
import type { AuthenticatedRequest } from "../types.js";

const router = Router();

router.post(
  "/session/close",
  asyncHandler(async (request, response) => {
    const actor = requireActor(request);
    requireCsrf(request);
    await transaction(async (client) => {
      await client.query(
        "UPDATE sessions SET revoked_at=COALESCE(revoked_at,home_tunnel_now()) WHERE id=?",
        [actor.sessionId],
      );
      await audit(client, request, "SessionClosed", "Session", actor.sessionId, null, null);
    });
    if (actor.authSource === "cookie") clearSessionCookies(response);
    response.status(204).end();
  }),
);

function managementActor(request: AuthenticatedRequest) {
  const actor = requirePasswordNormal(request);
  requireCsrf(request);
  if (actor.deviceId) throw new HttpError(403, "FORBIDDEN", "请使用账号管理会话");
  return actor;
}

router.get(
  "/session",
  asyncHandler(async (request, response) => {
    const actor = requireActor(request);
    const csrf = sessionCsrf(actor.sessionId);
    // Upgrade existing sessions without rotating browser cookies on page load.
    if (tokenHash(csrf) !== actor.csrfTokenHash)
      await query("UPDATE sessions SET csrf_token_hash=? WHERE id=?", [
        tokenHash(csrf),
        actor.sessionId,
      ]);
    response.setHeader("cache-control", "no-store");
    response.json({
      csrf_token: csrf,
      session_id: actor.sessionId,
      native_window_id: actor.nativeWindowId ?? null,
    });
  }),
);

router.get(
  "/sessions",
  asyncHandler(async (request, response) => {
    const actor = managementActor(request);
    const limit = 100;
    const rows = await query<{
      id: string;
      client_type: string;
      user_agent: string;
      created_at: Date;
      updated_at: Date;
      refresh_expires_at: Date;
    }>(
      `SELECT id,client_type,user_agent,created_at,updated_at,refresh_expires_at FROM sessions
     WHERE user_id=? AND device_id IS NULL AND revoked_at IS NULL AND refresh_expires_at>home_tunnel_now()
     ORDER BY created_at DESC,id DESC LIMIT ?`,
      [actor.userId, limit + 1],
    );
    response.json({
      items: rows.slice(0, limit).map((row) => ({ ...row, current: row.id === actor.sessionId })),
      has_more: rows.length > limit,
    });
  }),
);

router.delete(
  "/sessions/:id",
  asyncHandler(async (request, response) => {
    const actor = managementActor(request);
    const id = pathParam(request, "id");
    await transaction(async (client) => {
      const revoked = await client.query(
        "UPDATE sessions SET revoked_at=COALESCE(revoked_at,home_tunnel_now()) WHERE id=? AND user_id=? AND device_id IS NULL RETURNING id",
        [id, actor.userId],
      );
      if (!revoked.rowCount)
        throw new HttpError(404, "NOT_FOUND", "管理会话不存在；设备凭据请在设备管理中撤销");
      await audit(client, request, "ManagementSessionRevoked", "Session", id, null, null);
    });
    if (id === actor.sessionId) clearSessionCookies(response);
    response.status(204).end();
  }),
);

export { router as accountSecurityRouter };
