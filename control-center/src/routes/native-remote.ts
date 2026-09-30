import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { transaction } from "../db.js";
import {
  asyncHandler,
  HttpError,
  issueSession,
  requirePasswordNormal,
  setSessionCookies,
} from "../http.js";
import { FixedWindowLimiter, opaqueToken, tokenHash } from "../security.js";
import { parseBody } from "../validation.js";

export const nativeRemoteRouter = Router();
export const nativeRemotePublicRouter = Router();
const limiter = new FixedWindowLimiter(20, 60_000);
const invalid = () =>
  new HttpError(401, "NATIVE_HANDOFF_INVALID", "远程窗口授权已失效，请从客户端重新打开");

nativeRemoteRouter.post(
  "/native-remote-handoff",
  asyncHandler(async (request, response) => {
    const actor = requirePasswordNormal(request);
    const body = parseBody(z.strictObject({ origin: z.string().max(512) }), request.body);
    const origin = new URL(config.publicBaseUrl).origin;
    if (!actor.deviceId || actor.nativeRemote || actor.authSource !== "bearer")
      throw new HttpError(403, "NATIVE_DEVICE_REQUIRED", "需要本机设备身份");
    if (body.origin !== origin)
      throw new HttpError(403, "NATIVE_ORIGIN_INVALID", "远程窗口来源不匹配");
    if (!limiter.take(`${request.ip}:${actor.sessionId}`).allowed)
      throw new HttpError(429, "RATE_LIMITED", "远程窗口打开过于频繁");
    const code = opaqueToken(32);
    const expiresAt = new Date(Date.now() + 30_000).toISOString();
    await transaction(async (db) => {
      const parent = await db.query(
        `SELECT s.id FROM sessions s JOIN devices d ON d.id=s.device_id
      WHERE s.id=? AND s.client_type='device' AND s.native_parent_session_id IS NULL
      AND s.revoked_at IS NULL AND s.access_expires_at>home_tunnel_now() AND s.token_version=?
      AND d.user_id=? AND d.status='active' AND d.revoked_at IS NULL`,
        [actor.sessionId, actor.tokenVersion, actor.userId],
      );
      if (!parent.rows.length) throw invalid();
      await db.query(
        "DELETE FROM native_remote_handoffs WHERE expires_at<=home_tunnel_now() OR parent_session_id=?",
        [actor.sessionId],
      );
      const count = await db.query<{ count: number }>(
        "SELECT count(*) AS count FROM native_remote_handoffs",
      );
      if (Number(count.rows[0]?.count) >= 10000)
        throw new HttpError(429, "RATE_LIMITED", "远程窗口授权繁忙");
      await db.query(
        "INSERT INTO native_remote_handoffs(code_hash,parent_session_id,origin,expires_at) VALUES(?,?,?,?)",
        [tokenHash(code), actor.sessionId, origin, expiresAt],
      );
    });
    response.setHeader("cache-control", "no-store");
    response.json({ code, expires_at: expiresAt, window_id: actor.sessionId });
  }),
);

// Mounted before cookie authentication: an expired/different browser cookie must
// not prevent an explicitly authorized desktop handoff from replacing it.
nativeRemotePublicRouter.post(
  "/native-remote-handoff/redeem",
  asyncHandler(async (request, response) => {
    const origin = new URL(config.publicBaseUrl).origin;
    if (
      request.header("origin") !== origin ||
      request.header("sec-fetch-site") !== "same-origin" ||
      !request.is("application/json")
    )
      throw new HttpError(403, "NATIVE_ORIGIN_INVALID", "远程窗口来源不匹配");
    if (!limiter.take(`redeem:${request.ip}`).allowed)
      throw new HttpError(429, "RATE_LIMITED", "远程窗口授权繁忙");
    const body = parseBody(
      z.strictObject({ code: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
      request.body,
    );
    const result = await transaction(async (db) => {
      const match = await db.query<{
        parent_session_id: string;
        user_id: string;
        device_id: string;
        token_version: number;
      }>(
        `SELECT h.parent_session_id,s.user_id,s.device_id,s.token_version FROM native_remote_handoffs h
       JOIN sessions s ON s.id=h.parent_session_id JOIN users u ON u.id=s.user_id JOIN devices d ON d.id=s.device_id
       WHERE h.code_hash=? AND h.origin=? AND h.consumed_at IS NULL AND h.expires_at>home_tunnel_now()
         AND s.client_type='device' AND s.native_parent_session_id IS NULL AND s.revoked_at IS NULL
         AND s.access_expires_at>home_tunnel_now() AND s.token_version=u.token_version
         AND u.status='active' AND u.deleted_at IS NULL AND u.password_state='normal'
         AND d.user_id=u.id AND d.status='active' AND d.revoked_at IS NULL`,
        [tokenHash(body.code), origin],
      );
      const parent = match.rows[0];
      if (!parent) throw invalid();
      const consumed = await db.query(
        "UPDATE native_remote_handoffs SET consumed_at=home_tunnel_now() WHERE code_hash=? AND consumed_at IS NULL",
        [tokenHash(body.code)],
      );
      if (consumed.rowCount !== 1) throw invalid();
      const session = await issueSession(
        db,
        { id: parent.user_id, token_version: parent.token_version },
        parent.device_id,
        "native_remote",
        request.header("user-agent"),
      );
      // Eight hours is a hard maximum; a refresh never extends this window.
      const expiresAt = new Date(
        Date.now() + Math.min(config.refreshTokenSeconds, 8 * 3600) * 1000,
      ).toISOString();
      await db.query(
        "UPDATE sessions SET native_parent_session_id=?,refresh_expires_at=? WHERE id=?",
        [parent.parent_session_id, expiresAt, session.sessionId],
      );
      return { session, deviceId: parent.device_id, expiresAt };
    });
    setSessionCookies(response, result.session.accessToken, result.session.refreshToken);
    response.setHeader("cache-control", "no-store");
    response.json({
      csrf_token: result.session.csrfToken,
      device_id: result.deviceId,
      expires_at: result.expiresAt,
    });
  }),
);
