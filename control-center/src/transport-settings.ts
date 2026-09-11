import { z } from "zod";
import type { DatabaseClient } from "./db.js";
import { config } from "./config.js";
import { HttpError } from "./http.js";

const protocols = ["tcp", "udp"] as const;
type Protocol = (typeof protocols)[number];
export const transportPolicySchema = z
  .object({
    enabled: z.boolean(),
    port_start: z.number().int().min(1).max(65_535),
    port_end: z.number().int().min(1).max(65_535),
  })
  .strict()
  .refine((value) => value.port_start <= value.port_end, "起始端口不能大于结束端口");
export const transportPatchSchema = z
  .object({ tcp: transportPolicySchema.optional(), udp: transportPolicySchema.optional() })
  .strict()
  .refine((value) => value.tcp !== undefined || value.udp !== undefined);
const storedSchema = z.object({
  version: z.number().int().min(0),
  tcp: transportPolicySchema,
  udp: transportPolicySchema,
});
type StoredPolicy = z.infer<typeof storedSchema>;

async function storedPolicy(client: DatabaseClient): Promise<StoredPolicy> {
  const result = await client.query<{ value: string }>(
    "SELECT value FROM deployment_settings WHERE key='transport_tunnels'",
  );
  if (result.rows[0]) return storedSchema.parse(JSON.parse(result.rows[0].value));
  const initial = (type: Protocol) => ({
    enabled: config.transportTunnels[type].enabled,
    port_start: config.transportTunnels[type].portStart,
    port_end: config.transportTunnels[type].portEnd,
  });
  // Existing deployments retain their environment settings until an administrator saves.
  return { version: 0, tcp: initial("tcp"), udp: initial("udp") };
}

function resolvePolicy(stored: StoredPolicy) {
  const resolve = (type: Protocol) => {
    const desired = stored[type];
    const pool = config.transportTunnels[type];
    const ready = config.transportPortPools[type] || pool.enabled;
    const rangeAvailable = desired.port_start >= pool.portStart && desired.port_end <= pool.portEnd;
    return {
      ...desired,
      enabled: ready && rangeAvailable && desired.enabled,
      configured_enabled: desired.enabled,
      deployment_ready: ready,
      range_available: rangeAvailable,
      pool_start: pool.portStart,
      pool_end: pool.portEnd,
    };
  };
  return {
    transport_settings_version: stored.version,
    transport_tunnels: { tcp: resolve("tcp"), udp: resolve("udp") },
  };
}

export async function transportSettings(client: DatabaseClient) {
  return resolvePolicy(await storedPolicy(client));
}

// Keep the existing catalog/summary response shape for older management clients.
export async function transportCatalog(client: DatabaseClient) {
  const { transport_tunnels: settings } = await transportSettings(client);
  const catalog = (type: Protocol) => ({
    enabled: settings[type].enabled,
    port_start: settings[type].port_start,
    port_end: settings[type].port_end,
  });
  return { tcp: catalog("tcp"), udp: catalog("udp") };
}

export async function transportSettingsSummary(client: DatabaseClient) {
  const settings = await transportSettings(client);
  const usage = async (type: Protocol) => {
    const policy = settings.transport_tunnels[type];
    const result = await client.query<{ allocated: number; active: number }>(
      `SELECT count(*) FILTER (WHERE remote_port BETWEEN ? AND ?) AS allocated,
              count(*) FILTER (WHERE enabled=1) AS active
         FROM connections WHERE transport_type=? AND deleted_at IS NULL`,
      [policy.port_start, policy.port_end, type],
    );
    const allocated = Number(result.rows[0]?.allocated ?? 0);
    return {
      ...policy,
      allocated_ports: allocated,
      available_ports:
        policy.deployment_ready && policy.range_available
          ? Math.max(0, policy.port_end - policy.port_start + 1 - allocated)
          : 0,
      active_connections: Number(result.rows[0]?.active ?? 0),
    };
  };
  return {
    ...settings,
    transport_tunnels: { tcp: await usage("tcp"), udp: await usage("udp") },
  };
}

export async function updateTransportSettings(
  client: DatabaseClient,
  patch: z.infer<typeof transportPatchSchema>,
  expectedVersion: number,
) {
  const before = await storedPolicy(client);
  if (before.version !== expectedVersion) {
    throw new HttpError(
      409,
      "TRANSPORT_SETTINGS_CONFLICT",
      "端口设置已被其他页面修改，请刷新后重试",
    );
  }
  const after: StoredPolicy = { ...before };
  let changed = false;
  for (const type of protocols) {
    const desired = patch[type];
    if (!desired) continue;
    if (JSON.stringify(before[type]) === JSON.stringify(desired)) continue;
    const pool = config.transportTunnels[type];
    if (!(config.transportPortPools[type] || pool.enabled)) {
      throw new HttpError(
        409,
        "TRANSPORT_POOL_UNAVAILABLE",
        `${type.toUpperCase()} 端口池尚未准备，请先完成一次性部署配置`,
      );
    }
    if (desired.port_start < pool.portStart || desired.port_end > pool.portEnd) {
      throw new HttpError(
        400,
        "TRANSPORT_RANGE_NOT_AVAILABLE",
        `${type.toUpperCase()} 可用范围为 ${pool.portStart}-${pool.portEnd}，扩容需先调整部署端口池`,
      );
    }
    const conflicts = await client.query<{ count: number }>(
      `SELECT count(*) AS count FROM connections
        WHERE transport_type=? AND deleted_at IS NULL AND enabled=1
          AND (?=0 OR remote_port NOT BETWEEN ? AND ?)`,
      [type, desired.enabled, desired.port_start, desired.port_end],
    );
    const count = Number(conflicts.rows[0]?.count ?? 0);
    if (count > 0) {
      throw new HttpError(
        409,
        "TRANSPORT_CONNECTIONS_ACTIVE",
        `${type.toUpperCase()} 设置会影响 ${count} 条已启用连接，请先在连接管理中暂停或调整这些连接`,
        { protocol: type, affected_connections: count },
      );
    }
    after[type] = desired;
    changed = true;
  }
  if (changed) {
    after.version++;
    await client.query(
      `INSERT INTO deployment_settings(key,value,updated_at) VALUES('transport_tunnels',?,home_tunnel_now())
       ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
      [JSON.stringify(after)],
    );
  }
  return resolvePolicy(after);
}
