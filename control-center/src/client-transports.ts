import type { DatabaseClient } from "./db.js";
import { config } from "./config.js";
import { HttpError } from "./http.js";

export async function clientRawTunnelsEnabled(client: DatabaseClient): Promise<boolean> {
  const result = await client.query<{ value: string }>(
    "SELECT value FROM deployment_settings WHERE key='client_raw_tunnels_enabled'",
  );
  return result.rows[0]?.value === "true";
}

export async function setClientRawTunnelsEnabled(
  client: DatabaseClient,
  enabled: boolean,
): Promise<void> {
  await client.query(
    `INSERT INTO deployment_settings(key,value,updated_at) VALUES('client_raw_tunnels_enabled',?,home_tunnel_now())
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=home_tunnel_now()`,
    [String(enabled)],
  );
}

export async function clientConnectionCapabilities(client: DatabaseClient, role: string) {
  const allowed = role === "admin" || (await clientRawTunnelsEnabled(client));
  const transport = (type: "tcp" | "udp") => ({
    enabled: config.transportTunnels[type].enabled,
    can_create: allowed && config.transportTunnels[type].enabled,
    port_start: config.transportTunnels[type].portStart,
    port_end: config.transportTunnels[type].portEnd,
  });
  return { supported: true, tcp: transport("tcp"), udp: transport("udp"), automatic_ports: true };
}

// Called inside the same serialized transaction as INSERT, so simultaneous
// clients cannot reserve the same port. TCP and UDP use separate namespaces.
export async function allocateClientPort(
  client: DatabaseClient,
  role: string,
  type: "tcp" | "udp",
): Promise<number> {
  const settings = config.transportTunnels[type];
  if (!settings.enabled)
    throw new HttpError(
      403,
      `${type.toUpperCase()}_TUNNELS_DISABLED`,
      `服务端尚未开放 ${type.toUpperCase()} 端口，请联系管理员`,
    );
  if (role !== "admin" && !(await clientRawTunnelsEnabled(client)))
    throw new HttpError(
      403,
      "CLIENT_RAW_TUNNELS_DISABLED",
      "管理员尚未允许普通用户自行创建 TCP/UDP 连接",
    );
  const occupied = await client.query<{ remote_port: number }>(
    "SELECT remote_port FROM connections WHERE transport_type=? AND deleted_at IS NULL AND remote_port BETWEEN ? AND ? ORDER BY remote_port",
    [type, settings.portStart, settings.portEnd],
  );
  let candidate = settings.portStart;
  for (const row of occupied.rows) {
    const port = Number(row.remote_port);
    if (port > candidate) break;
    if (port === candidate) candidate++;
  }
  if (candidate > settings.portEnd)
    throw new HttpError(
      409,
      "PORT_POOL_EXHAUSTED",
      `${type.toUpperCase()} 可用端口已分配完，请联系管理员扩容`,
    );
  return candidate;
}
