import { HttpError } from "./http.js";

export const tunnelTransports = ["http", "https", "tcp", "udp"] as const;
export const tunnelFailures = [
  "none",
  "dns",
  "tls",
  "target_unreachable",
  "permission",
  "sync",
  "port_unavailable",
  "udp_unreachable",
] as const;
export const tunnelActions = [
  "none",
  "check_target_dns",
  "check_target_tls",
  "check_local_service",
  "check_device_permission",
  "retry_sync",
  "check_remote_port",
  "check_udp_path",
] as const;

export type TunnelDiagnostic = {
  source: "agent";
  target: "device_local";
  transport: (typeof tunnelTransports)[number];
  failure: (typeof tunnelFailures)[number];
  retryable: boolean;
  action: (typeof tunnelActions)[number];
};

const actions: Record<(typeof tunnelFailures)[number], (typeof tunnelActions)[number]> = {
  none: "none",
  dns: "check_target_dns",
  tls: "check_target_tls",
  target_unreachable: "check_local_service",
  permission: "check_device_permission",
  sync: "retry_sync",
  port_unavailable: "check_remote_port",
  udp_unreachable: "check_udp_path",
};

function reject(code: string, message: string): never {
  throw new HttpError(400, code, message);
}

// The control plane stores the device agent's own report. It does not resolve
// or connect to the device's local target, including names such as localhost.
export function normalizeAgentDiagnostic(
  input: {
    source: string;
    target: string;
    transport: string;
    failure: string;
    retryable: boolean;
  },
  connection: { proxy_type: string; local_scheme: string },
): TunnelDiagnostic {
  if (input.source !== "agent" || input.target !== "device_local")
    reject("TUNNEL_DIAGNOSTIC_REJECTED", "控制面不探测设备本机地址；诊断只能由设备上的代理报告");
  const proxy = connection.proxy_type;
  const allowed = proxy === "udp" ? ["udp"] : proxy === "tcp" ? ["tcp"] : [connection.local_scheme];
  if (!tunnelTransports.includes(input.transport as TunnelDiagnostic["transport"]))
    reject("TUNNEL_TRANSPORT_UNSUPPORTED", "不支持的隧道诊断传输");
  if (!allowed.includes(input.transport))
    reject("TUNNEL_TRANSPORT_UNSUPPORTED", "诊断传输与隧道类型不一致");
  if (!tunnelFailures.includes(input.failure as TunnelDiagnostic["failure"]))
    reject("TUNNEL_DIAGNOSTIC_REJECTED", "不支持的隧道失败原因");
  const failure = input.failure as TunnelDiagnostic["failure"];
  const transport = input.transport as TunnelDiagnostic["transport"];
  if (failure === "tls" && transport !== "https")
    reject("TUNNEL_TRANSPORT_UNSUPPORTED", "TLS 诊断只适用于 HTTPS 目标");
  if (failure === "udp_unreachable" && transport !== "udp")
    reject("TUNNEL_TRANSPORT_UNSUPPORTED", "UDP 诊断只适用于 UDP 隧道");
  if (failure === "port_unavailable" && transport !== "tcp" && transport !== "udp")
    reject("TUNNEL_TRANSPORT_UNSUPPORTED", "端口诊断只适用于 TCP 或 UDP 隧道");
  return {
    source: "agent",
    target: "device_local",
    transport,
    failure,
    retryable: failure === "none" ? false : input.retryable,
    action: actions[failure],
  };
}
