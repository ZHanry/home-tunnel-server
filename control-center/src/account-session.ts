// Apply to every device entry point, including the legacy Agent authentication APIs.
export const deviceSessionLive = `(
  s.device_id IS NULL OR EXISTS(
    SELECT 1 FROM devices live_device WHERE live_device.id=s.device_id
      AND live_device.user_id=s.user_id AND live_device.status='active'
      AND live_device.revoked_at IS NULL
      AND (live_device.credential_purpose='background' OR s.management_parent_session_id IS NOT NULL)
  )
) AND (
  s.management_parent_session_id IS NULL OR EXISTS(
    SELECT 1 FROM sessions management_parent JOIN users management_user
      ON management_user.id=management_parent.user_id
    WHERE management_parent.id=s.management_parent_session_id
      AND management_parent.user_id=s.user_id AND management_parent.device_id IS NULL
      AND management_parent.revoked_at IS NULL
      AND management_parent.refresh_expires_at>home_tunnel_now()
      AND management_parent.token_version=management_user.token_version
      AND management_user.status='active' AND management_user.password_state='normal'
  )
)`;

export function deviceSessionLiveFor(alias: string): string {
  return deviceSessionLive.replace(/\bs\./g, `${alias}.`);
}
