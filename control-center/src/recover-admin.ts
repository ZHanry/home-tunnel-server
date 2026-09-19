import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { config } from "./config.js";
import { closeDatabase, migrate, transaction } from "./db.js";
import { hashPassword, opaqueToken } from "./security.js";

// Host-only recovery. No HTTP route exposes this operation. The deployment
// wrapper stops control-center before opening its database with this command.
export async function recoverAdministrator(): Promise<{
  username: string;
  temporary_password: string;
  expires_at: string;
}> {
  const temporaryPassword = `Recover-${opaqueToken(24)}-Q8`;
  const hash = await hashPassword(temporaryPassword);
  const expiresAt = new Date(Date.now() + 60 * 60_000);
  const username = await transaction(async (client) => {
    const users = await client.query<{ id: string; username: string; token_version: number }>(
      "SELECT id,username,token_version FROM users WHERE role='admin' AND deleted_at IS NULL",
    );
    if (users.rows.length !== 1)
      throw new Error("Recovery requires exactly one existing administrator");
    const user = users.rows[0]!;
    await client.query(
      `UPDATE users SET password_hash=?,password_state='must_change',temporary_password_expires_at=?,
      status='active',token_version=token_version+1,version=version+1,mfa_secret=NULL,mfa_pending_secret=NULL,
      mfa_pending_expires_at=NULL,mfa_last_counter=-1,updated_at=home_tunnel_now() WHERE id=?`,
      [hash, expiresAt, user.id],
    );
    await client.query("DELETE FROM mfa_recovery_codes WHERE user_id=?", [user.id]);
    await client.query(
      "UPDATE sessions SET revoked_at=COALESCE(revoked_at,home_tunnel_now()) WHERE user_id=?",
      [user.id],
    );
    await client.query(
      "UPDATE enrollment_codes SET revoked_at=COALESCE(revoked_at,home_tunnel_now()) WHERE user_id=? AND consumed_at IS NULL",
      [user.id],
    );
    await client.query(
      "INSERT INTO audit_events(actor_type,action,target_type,target_id,after_value,request_id) VALUES('system','AdministratorRecoveredOffline','User',?,?,?)",
      [
        user.id,
        JSON.stringify({
          sessions_revoked: true,
          mfa_reset: true,
          temporary_password_expires_at: expiresAt,
        }),
        randomUUID(),
      ],
    );
    await client.query(
      "INSERT INTO outbox_events(event_type,resource_type,resource_id,resource_version,recipient_user_id,payload) VALUES('subject.revoked','User',?,?,?,?)",
      [
        user.id,
        Number(user.token_version) + 1,
        user.id,
        JSON.stringify({ subject_type: "user", subject_id: user.id }),
      ],
    );
    return user.username;
  });
  return { username, temporary_password: temporaryPassword, expires_at: expiresAt.toISOString() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes("--confirm-service-stopped") || config.database.path === ":memory:") {
    console.error(
      "Stop control-center, then run this host-only command with --confirm-service-stopped against its persistent database.",
    );
    process.exitCode = 2;
  } else {
    try {
      await migrate();
      console.log(JSON.stringify(await recoverAdministrator()));
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Recovery failed");
      process.exitCode = 1;
    }
  }
  await closeDatabase();
}
