import { APP_VERSION } from "./version.js";
import { rdConfig, relayEnabled } from "./rd/config.js";
import { homedeskConfig } from "./homedesk.js";

export const apiCapabilities = {
  api_major: 1,
  contract_version: "1.6.0",
  server_version: APP_VERSION,
  minimum_clients: { desktop: "7.0.0", android: "7.0.0", agent: "7.0.0" },
  openapi_url: "/openapi.v1.json",
  schema_url: "/api-schema.v1.json",
  homedesk: {
    enabled: homedeskConfig.configured,
    directory_version: 1,
    minimum_client: "11.0.0-rc.2",
    policy: "require_direct",
    relay_enabled: false,
    config_path: "/api/v1/homedesk/config",
    devices_path: "/api/v1/homedesk/devices",
    online_means: "recent_directory_report",
  },
  remote_desktop: {
    enabled: rdConfig.enabled,
    protocol: { major: 1, minor: 0 },
    signal_path: "/api/v1/rd/signal",
    udp_only: true,
    allow_turn: false,
    allow_ice_tcp: false,
    discovered_only: true,
    native_media: "signed_endpoint_report",
    server_probes_device_localhost: false,
    stun_urls: rdConfig.stunUrls,
    // Legacy fields above stay direct-only for 9.x clients; 10.x reads this block.
    relay: {
      enabled: relayEnabled(),
      protocol: "udp",
      ice_servers_path: "/api/v1/rd/sessions/{session_id}/ice-servers",
    },
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
    "management_sessions",
    "device_metadata",
    "batch_connections",
    "durable_backup_health",
    "http_latency_metrics",
    "tunnel_agent_diagnostics",
    "homedesk_directory_v1",
    "remote_require_direct",
  ],
  limits: {
    page_size: 100,
    devices_per_account: 1000,
    connections_per_account: 1000,
    connections_per_device: 250,
    batch_connections: 50,
    device_tags: 12,
  },
} as const;
