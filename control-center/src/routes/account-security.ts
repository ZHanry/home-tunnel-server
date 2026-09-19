import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { one, query, transaction, type DatabaseClient } from "../db.js";
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
import { matchingTotpCounter, newTotpSecret, replaceRecoveryCodes, verifyMfa } from "../mfa.js";
import { openSecret, sealSecret, sessionCsrf } from "../protected-secrets.js";
import { FixedWindowLimiter, tokenHash, verifyPassword } from "../security.js";
import type { AuthenticatedRequest } from "../types.js";
import { parseBody } from "../validation.js";

const router = Router();
const securityLimiter = new FixedWindowLimiter(8, 10 * 60_000);
const credentialsSchema = z.object({
  password: z.string().min(1).max(256),
  mfa_code: z.string().max(128).optional(),
});

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

async function reauthenticate(
  client: DatabaseClient,
  request: AuthenticatedRequest,
  body: z.infer<typeof credentialsSchema>,
) {
  const actor = managementActor(request);
  if (!securityLimiter.take(`${request.ip}:${actor.userId}`).allowed)
    throw new HttpError(429, "RATE_LIMITED", "安全设置尝试过多，请稍后重试");
  const user = (
    await client.query<{ password_hash: string; token_version: number }>(
      "SELECT password_hash,token_version FROM users WHERE id=?",
      [actor.userId],
    )
  ).rows[0];
  if (
    !user ||
    Number(user.token_version) !== actor.tokenVersion ||
    !(await verifyPassword(user.password_hash, body.password))
  )
    throw new HttpError(401, "AUTH_INVALID", "当前密码错误或会话已过期");
  await verifyMfa(client, actor.userId, body.mfa_code);
  return actor;
}

async function revokeOtherManagementSessions(
  client: DatabaseClient,
  userId: string,
  sessionId: string,
) {
  await client.query(
    "UPDATE sessions SET revoked_at=COALESCE(revoked_at,home_tunnel_now()) WHERE user_id=? AND device_id IS NULL AND id<>?",
    [userId, sessionId],
  );
  await client.query(
    "UPDATE enrollment_codes SET revoked_at=COALESCE(revoked_at,home_tunnel_now()) WHERE user_id=? AND consumed_at IS NULL",
    [userId],
  );
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
    response.json({ csrf_token: csrf, session_id: actor.sessionId });
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

router.get(
  "/mfa",
  asyncHandler(async (request, response) => {
    const actor = managementActor(request);
    const user = await one<{ enabled: number; recovery_codes_remaining: number }>(
      `SELECT mfa_secret IS NOT NULL AS enabled,
    (SELECT count(*) FROM mfa_recovery_codes WHERE user_id=u.id AND used_at IS NULL) AS recovery_codes_remaining FROM users u WHERE id=?`,
      [actor.userId],
    );
    response.json({
      enabled: Boolean(user?.enabled),
      recovery_codes_remaining: Number(user?.recovery_codes_remaining ?? 0),
    });
  }),
);

router.post(
  "/mfa/setup",
  asyncHandler(async (request, response) => {
    const body = parseBody(credentialsSchema, request.body);
    const secret = newTotpSecret();
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    const actor = await transaction(async (client) => {
      const actor = await reauthenticate(client, request, body);
      const current = (
        await client.query<{ mfa_secret: string | null }>(
          "SELECT mfa_secret FROM users WHERE id=?",
          [actor.userId],
        )
      ).rows[0];
      if (current?.mfa_secret)
        throw new HttpError(409, "STATE_CONFLICT", "已启用双重验证，请先关闭后再更换验证器");
      await client.query(
        "UPDATE users SET mfa_pending_secret=?,mfa_pending_expires_at=? WHERE id=?",
        [sealSecret(secret, `mfa:${actor.userId}`), expiresAt, actor.userId],
      );
      await audit(client, request, "MfaSetupStarted", "User", actor.userId, null, null);
      return actor;
    });
    const issuer = `Home Tunnel (${new URL(config.publicBaseUrl).host})`;
    const uri = `otpauth://totp/${encodeURIComponent(`${issuer}:${actor.username}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
    response.setHeader("cache-control", "no-store");
    response.json({ secret, otpauth_uri: uri, expires_at: expiresAt });
  }),
);

router.post(
  "/mfa/confirm",
  asyncHandler(async (request, response) => {
    const body = parseBody(
      credentialsSchema.extend({ code: z.string().regex(/^\d{6}$/) }),
      request.body,
    );
    const codes = await transaction(async (client) => {
      const actor = await reauthenticate(client, request, body);
      const user = (
        await client.query<{
          mfa_pending_secret: string | null;
          mfa_pending_expires_at: Date | null;
          mfa_secret: string | null;
        }>("SELECT mfa_pending_secret,mfa_pending_expires_at,mfa_secret FROM users WHERE id=?", [
          actor.userId,
        ])
      ).rows[0];
      if (
        user?.mfa_secret ||
        !user?.mfa_pending_secret ||
        !user.mfa_pending_expires_at ||
        user.mfa_pending_expires_at.getTime() <= Date.now()
      )
        throw new HttpError(409, "STATE_CONFLICT", "设置已过期，请重新添加验证器");
      const counter = matchingTotpCounter(
        openSecret(user.mfa_pending_secret, `mfa:${actor.userId}`),
        body.code,
      );
      if (counter === null) throw new HttpError(401, "MFA_INVALID", "动态码无效");
      await client.query(
        "UPDATE users SET mfa_secret=mfa_pending_secret,mfa_pending_secret=NULL,mfa_pending_expires_at=NULL,mfa_last_counter=? WHERE id=?",
        [counter, actor.userId],
      );
      const codes = await replaceRecoveryCodes(client, actor.userId);
      await revokeOtherManagementSessions(client, actor.userId, actor.sessionId);
      await audit(client, request, "MfaEnabled", "User", actor.userId, null, null);
      return codes;
    });
    response.setHeader("cache-control", "no-store");
    response.json({ enabled: true, recovery_codes: codes });
  }),
);

router.post(
  "/mfa/recovery-codes",
  asyncHandler(async (request, response) => {
    const body = parseBody(credentialsSchema, request.body);
    const codes = await transaction(async (client) => {
      const actor = await reauthenticate(client, request, body);
      const user = (
        await client.query<{ mfa_secret: string | null }>(
          "SELECT mfa_secret FROM users WHERE id=?",
          [actor.userId],
        )
      ).rows[0];
      if (!user?.mfa_secret) throw new HttpError(409, "STATE_CONFLICT", "尚未启用双重验证");
      const codes = await replaceRecoveryCodes(client, actor.userId);
      await audit(client, request, "MfaRecoveryCodesReplaced", "User", actor.userId, null, null);
      return codes;
    });
    response.setHeader("cache-control", "no-store");
    response.json({ recovery_codes: codes });
  }),
);

router.post(
  "/mfa/disable",
  asyncHandler(async (request, response) => {
    const body = parseBody(credentialsSchema, request.body);
    await transaction(async (client) => {
      const actor = await reauthenticate(client, request, body);
      await client.query(
        "UPDATE users SET mfa_secret=NULL,mfa_pending_secret=NULL,mfa_pending_expires_at=NULL,mfa_last_counter=-1 WHERE id=?",
        [actor.userId],
      );
      await client.query("DELETE FROM mfa_recovery_codes WHERE user_id=?", [actor.userId]);
      await revokeOtherManagementSessions(client, actor.userId, actor.sessionId);
      await audit(client, request, "MfaDisabled", "User", actor.userId, null, null);
    });
    response.status(204).end();
  }),
);

export { router as accountSecurityRouter };
