import { deviceSessionLiveFor } from "./account-session.js";

// Used wherever account sessions authorize HTTP, refresh, RD tokens or leases.
// The device and originating desktop session must remain live for the entire
// lifetime of a delegated remote window, including after cookie refresh.
export const nativeSessionLive = `(s.native_parent_session_id IS NULL OR (
  s.client_type='native_remote' AND s.device_id IS NOT NULL AND s.refresh_expires_at>home_tunnel_now() AND EXISTS(
    SELECT 1 FROM sessions native_parent JOIN devices native_device ON native_device.id=native_parent.device_id
    WHERE native_parent.id=s.native_parent_session_id AND native_parent.native_parent_session_id IS NULL
      AND native_parent.client_type='device' AND native_parent.user_id=s.user_id
      AND native_parent.device_id=s.device_id AND native_parent.token_version=s.token_version
      AND native_parent.revoked_at IS NULL AND native_parent.refresh_expires_at>home_tunnel_now()
      AND ${deviceSessionLiveFor("native_parent")}
      AND native_device.user_id=s.user_id AND native_device.status='active' AND native_device.revoked_at IS NULL
  )
))`;

export function nativeRemoteRouteAllowed(method: string, path: string): boolean {
  if (method === "GET" && ["/api/v1/auth/me", "/api/v1/auth/session"].includes(path)) return true;
  if (method === "POST" && ["/api/v1/auth/refresh", "/api/v1/auth/session/close"].includes(path))
    return true;
  if (
    method === "GET" &&
    /^\/api\/v1\/rd\/(?:server-keys|endpoints|grants|sessions)(?:\/[0-9a-f-]{36})?$/.test(path)
  )
    return true;
  return (
    method === "POST" &&
    ["enrollment-challenges", "endpoints", "token-challenges", "tokens"].some(
      (route) => path === `/api/v1/rd/${route}`,
    )
  );
}
