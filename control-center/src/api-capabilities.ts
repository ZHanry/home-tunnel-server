import { APP_VERSION } from "./version.js";
import { rdConfig } from "./rd/config.js";

export const apiCapabilities = {
  api_major: 1,
  contract_version: "1.2.0",
  server_version: APP_VERSION,
  minimum_clients: { desktop: "7.0.0", android: "7.0.0", agent: "7.0.0" },
  openapi_url: "/openapi.json",
  schema_url: "/api-schema.json",
  remote_desktop: {
    enabled: rdConfig.enabled,
    protocol: { major: 1, minor: 0 },
    signal_path: "/api/v1/rd/signal",
    udp_only: true,
    allow_turn: false,
    allow_ice_tcp: false,
    stun_urls: rdConfig.stunUrls,
    limits: {
      endpoints_per_user: rdConfig.endpointsPerUser,
      sessions_per_user: rdConfig.sessionsPerUser,
      sessions_per_controller: rdConfig.sessionsPerController,
      sessions_per_host: 1,
    },
  },
  features: [
    "paginated_lists",
    "transport_capabilities",
    "access_policy_versions",
    "totp_mfa",
    "management_sessions",
    "single_use_enrollment",
    "device_metadata",
    "batch_connections",
    "durable_backup_health",
    "http_latency_metrics",
  ],
  limits: {
    page_size: 100,
    devices_per_account: 1000,
    connections_per_account: 1000,
    connections_per_device: 250,
    batch_connections: 50,
    device_tags: 12,
    enrollment_seconds: 600,
  },
} as const;
