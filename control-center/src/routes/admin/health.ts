import { transportCatalog } from "../../transport-settings.js";
import { externalBackupHealth } from "../../external-backup.js";
import { createConnection as createSocketConnection } from "node:net";
import { Router } from "express";
import { one, pool, transaction } from "../../db.js";
import { asyncHandler, requireAdmin, requirePasswordNormal } from "../../http.js";
import { config } from "../../config.js";
import { APP_VERSION } from "../../version.js";
import { localBackupHealth } from "../../backup.js";

const router = Router();

async function tcpHealth(
  host: string,
  port: number,
): Promise<{ status: "healthy" | "unhealthy"; latency_ms: number }> {
  const started = performance.now();
  return new Promise((resolve) => {
    const socket = createSocketConnection({ host, port });
    let settled = false;
    const finish = (status: "healthy" | "unhealthy") => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ status, latency_ms: Math.round((performance.now() - started) * 10) / 10 });
    };
    socket.setTimeout(1500);
    socket.once("connect", () => finish("healthy"));
    socket.once("timeout", () => finish("unhealthy"));
    socket.once("error", () => finish("unhealthy"));
  });
}

async function gatewayHealth(): Promise<Record<string, unknown>> {
  const started = performance.now();
  try {
    const response = await fetch(config.gatewayHealthUrl, { signal: AbortSignal.timeout(1800) });
    const payload = (await response.json()) as {
      status?: string;
      revision?: number;
      policy_age_seconds?: number | null;
    };
    return {
      component: "traffic-gateway",
      status: response.ok && payload.status === "healthy" ? "healthy" : "unhealthy",
      latency_ms: Math.round((performance.now() - started) * 10) / 10,
      revision: payload.revision,
      policy_age_seconds: payload.policy_age_seconds,
    };
  } catch {
    return {
      component: "traffic-gateway",
      status: "unhealthy",
      latency_ms: Math.round((performance.now() - started) * 10) / 10,
    };
  }
}

async function backupHealth(): Promise<Record<string, unknown>> {
  const local = await localBackupHealth();
  const external = await externalBackupHealth();
  const offsite = external.backup;
  const externalHealthy =
    offsite.status === "healthy" &&
    offsite.scope === "offsite" &&
    offsite.restore_verified &&
    external.restore.status === "healthy";
  return {
    component: "backup",
    status:
      external.required || offsite.configured
        ? externalHealthy
          ? "healthy"
          : "degraded"
        : local.status,
    scope: externalHealthy ? "offsite" : "local_snapshot",
    local_snapshot: local,
    offsite,
    restore: external.restore,
    message: external.required ? "异机备份和完整恢复验证均需成功" : "本机快照与异机副本分别记录",
  };
}

router.get(
  "/summary",
  asyncHandler(async (request, response) => {
    requireAdmin(request);
    requirePasswordNormal(request);
    const summary = await one<{
      users: number;
      online_devices: number;
      connections: number;
      online_connections: number;
      upload_24h: string;
      download_24h: string;
      high_errors: number;
    }>(
      `SELECT
      (SELECT count(*) FROM users WHERE status='active') AS users,
      (SELECT count(*) FROM devices WHERE status='active' AND last_seen_at > home_tunnel_add_seconds(home_tunnel_now(), -90)) AS online_devices,
      (SELECT count(*) FROM connections WHERE deleted_at IS NULL) AS connections,
      (SELECT count(*) FROM runtime_states WHERE state='Online') AS online_connections,
      COALESCE((SELECT sum(upload_bytes) FROM traffic_samples WHERE bucket_start > home_tunnel_add_seconds(home_tunnel_now(), -86400)),'0') AS upload_24h,
      COALESCE((SELECT sum(download_bytes) FROM traffic_samples WHERE bucket_start > home_tunnel_add_seconds(home_tunnel_now(), -86400)),'0') AS download_24h,
      (SELECT count(*) FROM runtime_states WHERE state='Error') AS high_errors`,
    );
    const transports = await transaction(transportCatalog);
    response.json({
      ...summary,
      upload_24h: Number(summary?.upload_24h ?? 0),
      download_24h: Number(summary?.download_24h ?? 0),
      transport_tunnels: transports,
      tcp_tunnels: transports.tcp,
      at: new Date().toISOString(),
    });
  }),
);

router.get(
  "/system/health",
  asyncHandler(async (request, response) => {
    requireAdmin(request);
    requirePasswordNormal(request);
    const started = performance.now();
    const dbResult = await pool.query<{ now: Date }>("SELECT home_tunnel_now() AS now");
    const dbLatencyMs = Math.round((performance.now() - started) * 10) / 10;
    const outbox = await one<{ pending: number; oldest_at: Date | null }>(
      `SELECT count(*) AS pending,min(created_at) AS oldest_at FROM outbox_events WHERE delivered_at IS NULL`,
    );
    const oldestAgeSeconds = outbox?.oldest_at
      ? Math.max(0, Math.round((Date.now() - outbox.oldest_at.getTime()) / 1000))
      : 0;
    const [gateway, frpsProbe, caddyProbe, backup] = await Promise.all([
      gatewayHealth(),
      tcpHealth(config.frpsHost, config.frpsPort),
      tcpHealth(config.caddyHost, config.caddyPort),
      backupHealth(),
    ]);
    const components: Array<Record<string, unknown> & { status: string }> = [
      { component: "control-center", status: "healthy", version: APP_VERSION },
      {
        component: "sqlite",
        status: dbResult.rows[0] ? "healthy" : "unhealthy",
        latency_ms: dbLatencyMs,
      },
      {
        component: "outbox",
        status: oldestAgeSeconds <= 5 ? "healthy" : "degraded",
        pending: outbox?.pending ?? 0,
        oldest_age_seconds: oldestAgeSeconds,
      },
      gateway as Record<string, unknown> & { status: string },
      { component: "frps", ...frpsProbe },
      { component: "caddy", ...caddyProbe },
      backup as Record<string, unknown> & { status: string },
    ];
    const status = components.some((item) => item.status === "unhealthy")
      ? "unhealthy"
      : components.some((item) => item.status === "degraded" || item.status === "unknown")
        ? "degraded"
        : "healthy";
    response.json({ status, components, at: new Date().toISOString() });
  }),
);

export { router as healthRouter };
