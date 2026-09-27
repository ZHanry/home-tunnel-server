export const serviceTemplates = [
  { id: "http", name: "HTTP", proxy: "http", scheme: "http", port: 8080 },
  { id: "https", name: "HTTPS", proxy: "http", scheme: "https", port: 443 },
  { id: "nas", name: "NAS", proxy: "http", scheme: "http", port: 5000 },
  { id: "home-assistant", name: "Home Assistant", proxy: "http", scheme: "http", port: 8123 },
  { id: "immich", name: "Immich", proxy: "http", scheme: "http", port: 2283 },
  { id: "jellyfin", name: "Jellyfin", proxy: "http", scheme: "http", port: 8096 },
  { id: "ssh", name: "SSH", proxy: "tcp", port: 22, application: "ssh" },
  { id: "rdp", name: "RDP", proxy: "tcp", port: 3389, application: "rdp" },
  { id: "rtsp", name: "RTSP", proxy: "tcp", port: 554, application: "rtsp" },
  { id: "tcp", name: "TCP", proxy: "tcp", port: 8080 },
  { id: "udp", name: "UDP", proxy: "udp", port: 51820 },
];

export function tunnelVerification(connection, device) {
  if (!connection.enabled) return { state: "paused", message: "连接已保存并暂停。启用后才会发布服务。" };
  if (device && !device.online) return { state: "offline", message: "设备离线。请启动所选设备上的客户端，再刷新验证。" };
  const report = connection.diagnostic;
  if (report?.source === "agent" && report.target === "device_local" && report.failure !== "none") {
    const messages = {
      dns: "设备无法解析目标域名，请检查本地目标地址和设备 DNS。",
      tls: "设备无法验证目标 TLS，请检查目标证书和本地 HTTPS 配置。",
      target_unreachable: "设备无法访问本地服务，请检查地址、端口和服务状态。",
      permission: "设备无权访问目标，请检查设备授权和应用访问权限。",
      sync: "配置同步失败，请检查设备网络并重新同步。",
      port_unavailable: "公网端口不可用，请联系管理员检查端口池和占用。",
      udp_unreachable: "UDP 目标未响应，请检查服务和设备防火墙。",
    };
    return { state: "error", message: messages[report.failure] ?? "设备报告异常，请查看连接详情。" };
  }
  if (connection.last_error_code) return { state: "error", message: "设备报告异常，请查看连接详情。" };
  if (Number(connection.applied_version ?? 0) < Number(connection.version) || connection.state !== "Online")
    return { state: "pending", message: "配置已保存，正在等待设备应用。" };
  if (report?.source === "agent" && report.target === "device_local" && report.failure === "none")
    return { state: "verified", message: "设备已应用配置，并报告本地目标可达。请从外部网络检查公网地址。" };
  return { state: "pending", message: "隧道在线，尚未收到设备的目标验证结果。" };
}
