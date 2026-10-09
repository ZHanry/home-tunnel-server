import { Router } from "express";
import { z } from "zod";
import { one, transaction } from "../db.js";
import { deviceSessionLive } from "../account-session.js";
import { homedeskConfig } from "../homedesk.js";
import { asyncHandler, HttpError, pathParam, requireCsrf, requirePasswordNormal } from "../http.js";
import { issueRemotePermit, permitTrust, requireLivePermit } from "../remote-permit.js";
import { parseBody } from "../validation.js";

const router = Router();
router.use((_request, response, next) => {
  response.setHeader("cache-control", "no-store");
  next();
});
router.get(
  "/presence",
  asyncHandler(async (request, response) => {
    const actor = requirePasswordNormal(request);
    const device = await one<{ id: string }>(
      `SELECT d.id FROM sessions s JOIN devices d ON d.id=s.device_id WHERE s.id=?
    AND d.credential_purpose='gui' AND s.client_type='device' AND ${deviceSessionLive}`,
      [actor.sessionId],
    );
    if (!device) throw new HttpError(403, "GUI_SESSION_REQUIRED", "远控需要已登录的 GUI 设备");
    if (!homedeskConfig.configured)
      throw new HttpError(503, "HOMEDESK_UNCONFIGURED", "远控服务尚未配置");
    response.json({
      device_id: device.id,
      session_id: actor.sessionId,
      configured: true,
      server: homedeskConfig.server,
      key: homedeskConfig.key,
      key_sha256: homedeskConfig.key_sha256,
      family_cidr: "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16",
      source_cidr: "",
      permit_trust: permitTrust,
    });
  }),
);
router.post(
  "/permits",
  asyncHandler(async (request, response) => {
    const actor = requirePasswordNormal(request);
    requireCsrf(request);
    const body = parseBody(
      z.strictObject({ target_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }),
      request.body,
    );
    response
      .status(201)
      .json(await transaction((client) => issueRemotePermit(client, actor, body.target_id)));
  }),
);
router.post(
  "/permits/:id/accept",
  asyncHandler(async (request, response) => {
    const actor = requirePasswordNormal(request);
    requireCsrf(request);
    const body = parseBody(
      z.strictObject({ connection_id: z.string().regex(/^[1-9][0-9]{0,19}$/) }),
      request.body,
    );
    const result = await transaction(async (client) => {
      const row = await requireLivePermit(client, actor, pathParam(request, "id"));
      if (row.host_session_id !== actor.sessionId)
        throw new HttpError(403, "REMOTE_PERMIT_SCOPE", "仅被控设备可接受许可");
      if (row.peer_connection_id && row.peer_connection_id !== body.connection_id)
        throw new HttpError(409, "REMOTE_PERMIT_USED", "许可已用于其他连接");
      if (row.state === "pending" && row.claims_json.exp * 1000 <= Date.now())
        throw new HttpError(403, "REMOTE_PERMIT_EXPIRED", "远控许可已过期");
      await client.query(
        "UPDATE native_remote_permits SET state='active',peer_connection_id=?,host_seen_at=home_tunnel_now() WHERE id=?",
        [body.connection_id, row.id],
      );
      return {
        permit_id: row.id,
        active: true,
        peer_timeout_seconds: permitTrust.peer_timeout_seconds,
      };
    });
    response.json(result);
  }),
);
router.post(
  "/permits/:id/heartbeat",
  asyncHandler(async (request, response) => {
    const actor = requirePasswordNormal(request);
    requireCsrf(request);
    parseBody(z.strictObject({}), request.body ?? {});
    const result = await transaction(async (client) => {
      const row = await requireLivePermit(client, actor, pathParam(request, "id"));
      const controller = row.controller_session_id === actor.sessionId;
      const peerSeen = controller ? row.host_seen_at : row.controller_seen_at;
      if (
        row.state === "active" &&
        peerSeen.getTime() < Date.now() - permitTrust.peer_timeout_seconds * 1000
      )
        throw new HttpError(403, "REMOTE_PEER_EXPIRED", "对方登录或连接已结束");
      const expires = new Date(Date.now() + permitTrust.permit_seconds * 1000);
      await client.query(
        controller
          ? "UPDATE native_remote_permits SET controller_seen_at=home_tunnel_now(),expires_at=? WHERE id=?"
          : "UPDATE native_remote_permits SET host_seen_at=home_tunnel_now(),expires_at=? WHERE id=?",
        [row.state === "active" ? expires : new Date(row.claims_json.exp * 1000), row.id],
      );
      return {
        permit_id: row.id,
        active: row.state === "active",
        expires_at: row.state === "active" ? expires : new Date(row.claims_json.exp * 1000),
      };
    });
    response.json(result);
  }),
);
router.delete(
  "/permits/:id",
  asyncHandler(async (request, response) => {
    const actor = requirePasswordNormal(request);
    requireCsrf(request);
    await transaction(async (client) => {
      const id = pathParam(request, "id");
      const result = await client.query(
        "UPDATE native_remote_permits SET state='closed' WHERE id=? AND (controller_session_id=? OR host_session_id=?) RETURNING id",
        [id, actor.sessionId, actor.sessionId],
      );
      if (!result.rowCount) throw new HttpError(404, "REMOTE_PERMIT_UNKNOWN", "远控许可不存在");
    });
    response.status(204).end();
  }),
);
export { router as remotePermitsRouter };
