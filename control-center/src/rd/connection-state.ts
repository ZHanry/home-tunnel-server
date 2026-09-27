export const accessModes = [
  "local_approval",
  "one_time_password",
  "fixed_password",
  "unattended",
] as const;
export type AccessMode = (typeof accessModes)[number];

export const failureActions = [
  "none",
  "check_udp_path",
  "retry_session",
  "request_permission",
  "reauthenticate",
  "enable_host",
  "request_grant",
  "wait_for_host",
  "wait_for_approval",
  "enable_unattended",
  "reduce_permissions",
  "new_session",
  "reenroll",
  "switch_display",
] as const;
export type FailureAction = (typeof failureActions)[number];

export type FailureView = {
  code: string;
  retryable: boolean;
  action: FailureAction;
  retry_after_seconds: number | null;
};

const catalog: Record<string, Omit<FailureView, "code">> = {
  RD_NO_DIRECT_PATH: { retryable: true, action: "check_udp_path", retry_after_seconds: null },
  RD_MEDIA_FAILED: { retryable: true, action: "retry_session", retry_after_seconds: 0 },
  RD_PERMISSION_DENIED: {
    retryable: false,
    action: "request_permission",
    retry_after_seconds: null,
  },
  RD_PEER_AUTH_FAILED: { retryable: false, action: "reauthenticate", retry_after_seconds: null },
  RD_CANCELLED: { retryable: false, action: "none", retry_after_seconds: null },
  RD_HOST_DISABLED: { retryable: true, action: "enable_host", retry_after_seconds: null },
  RD_GRANT_REVOKED: { retryable: false, action: "request_grant", retry_after_seconds: null },
  RD_DISABLED: { retryable: false, action: "none", retry_after_seconds: null },
  RD_ADMIN_REVOKED: { retryable: false, action: "none", retry_after_seconds: null },
  RD_HOST_UNAVAILABLE: { retryable: true, action: "wait_for_host", retry_after_seconds: null },
  RD_UNATTENDED_DENIED: {
    retryable: false,
    action: "enable_unattended",
    retry_after_seconds: null,
  },
  RD_SCOPE_DENIED: { retryable: false, action: "reduce_permissions", retry_after_seconds: null },
  RD_RECONNECT_LIMIT: { retryable: true, action: "new_session", retry_after_seconds: 0 },
  RD_AUTH_REVOKED: { retryable: false, action: "reauthenticate", retry_after_seconds: null },
  RD_ENDPOINT_REVOKED: { retryable: false, action: "reenroll", retry_after_seconds: null },
  RD_INVITE_REVOKED: { retryable: false, action: "request_grant", retry_after_seconds: null },
  RD_GRANT_EXPIRED: { retryable: false, action: "request_grant", retry_after_seconds: null },
  RD_LEASE_EXPIRED: { retryable: true, action: "new_session", retry_after_seconds: 0 },
  RD_HOST_REJECTED: { retryable: false, action: "request_grant", retry_after_seconds: null },
  RD_CAPABILITY_UNSUPPORTED: {
    retryable: false,
    action: "reduce_permissions",
    retry_after_seconds: null,
  },
};

export function accessModeFor(mode: string | null, accessKind: string | null): AccessMode {
  if (mode === "persistent") return "unattended";
  if (accessKind === "temporary_password") return "one_time_password";
  if (accessKind === "fixed_password") return "fixed_password";
  return "local_approval";
}

export function failureView(code: string | null): FailureView | null {
  if (!code) return null;
  return {
    code,
    ...(catalog[code] ?? { retryable: false, action: "none", retry_after_seconds: null }),
  };
}

export function connectionStateFor(state: string, failure: FailureView | null) {
  const phase =
    state === "pending_approval"
      ? "waiting_for_approval"
      : state === "authorized" || state === "connecting"
        ? "direct_connect"
        : state === "active"
          ? "active"
          : state === "reconnecting"
            ? "recovering"
            : state === "closing"
              ? "ending"
              : "ended";
  if (failure) return { state, phase, retryable: failure.retryable, action: failure.action };
  if (phase === "waiting_for_approval")
    return { state, phase, retryable: false, action: "wait_for_approval" as const };
  if (phase === "direct_connect")
    return { state, phase, retryable: true, action: "check_udp_path" as const };
  if (phase === "recovering")
    return { state, phase, retryable: true, action: "retry_session" as const };
  if (phase === "ending") return { state, phase, retryable: false, action: "none" as const };
  return { state, phase, retryable: false, action: "none" as const };
}
