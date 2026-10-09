import { Router } from "express";
import { apiCapabilities } from "../api-capabilities.js";
import { asyncHandler, HttpError } from "../http.js";
import { compareReleaseVersions, parseReleaseVersion } from "../release-version.js";
import { APP_VERSION } from "../version.js";

export const apiCapabilitiesV2 = {
  ...apiCapabilities,
  api_major: 2,
  contract_version: "api-v2.0.0",
  openapi_url: "/openapi.v2.json",
  schema_url: "/api-schema.v2.json",
  minimum_clients: {
    desktop: "12.0.0-RC1",
    android: "12.0.0-RC1",
    agent: apiCapabilities.minimum_clients.agent,
  },
  homedesk: {
    ...apiCapabilities.homedesk,
    directory_version: 2,
    minimum_client: "12.0.0-RC1",
    config_path: "/api/v2/homedesk/config",
    devices_path: "/api/v2/homedesk/devices",
    online_means: "authenticated_gui_presence",
  },
  authentication: {
    mode: "self_hosted_account",
    devices_path: "/api/v2/auth/devices",
    gui_requires_management_session: true,
    background_independent: true,
  },
  remote: {
    permits_path: "/api/v2/remote/permits",
    algorithm: "Ed25519",
    permit_seconds: 45,
    heartbeat_seconds: 5,
    require_direct: true,
    cross_account_by_id: true,
  },
} as const;

type Release = { version: string; url: string; notes: string; prerelease: boolean };
const repositories = {
  server: "home-tunnel-server",
  client: "home-tunnel-client",
  android: "home-tunnel-android",
} as const;
type Component = keyof typeof repositories;
export function eligibleRelease(
  value: unknown,
  channel: "stable" | "rc",
  component: Component = "server",
): Release | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (
    raw.draft !== false ||
    typeof raw.tag_name !== "string" ||
    typeof raw.prerelease !== "boolean"
  )
    return null;
  const parsed = parseReleaseVersion(raw.tag_name);
  if (
    !parsed ||
    (channel === "stable" && (raw.prerelease || parsed.rc !== null)) ||
    raw.prerelease !== (parsed.rc !== null)
  )
    return null;
  return {
    version: raw.tag_name.replace(/^v/, ""),
    url: `https://github.com/ZHanry/${repositories[component]}/releases/tag/${encodeURIComponent(raw.tag_name)}`,
    notes: typeof raw.body === "string" ? raw.body.slice(0, 24_000) : "",
    prerelease: raw.prerelease,
  };
}
const cache = new Map<string, { latest: Release; expires: number }>();
const inFlight = new Map<string, Promise<Release>>();
async function latestRelease(component: Component, channel: "stable" | "rc"): Promise<Release> {
  const key = `${component}:${channel}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.latest;
  const running = inFlight.get(key);
  if (running) return running;
  const operation = (async () => {
    const response = await fetch(
      `https://api.github.com/repos/ZHanry/${repositories[component]}/releases?per_page=30`,
      {
        headers: { accept: "application/vnd.github+json", "user-agent": "NestLink" },
        signal: AbortSignal.timeout(6000),
      },
    );
    if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 2_000_000)
      throw new Error("Release check failed");
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error("Release metadata too large");
    const raw: unknown = JSON.parse(text);
    if (!Array.isArray(raw)) throw new Error("Invalid release listing");
    const releases = raw
      .map((value) => eligibleRelease(value, channel, component))
      .filter((value): value is Release => value !== null);
    releases.sort((a, b) => compareReleaseVersions(b.version, a.version));
    const latest = releases[0];
    if (!latest) throw new Error("No eligible release");
    cache.set(key, { latest, expires: Date.now() + 600_000 });
    return latest;
  })();
  inFlight.set(key, operation);
  try {
    return await operation;
  } finally {
    inFlight.delete(key);
  }
}
const router = Router();
router.get("/capabilities", (_request, response) => response.json(apiCapabilitiesV2));
router.get(
  "/updates/:component",
  asyncHandler(async (request, response) => {
    const component = request.params.component as Component;
    if (!Object.hasOwn(repositories, component)) throw new HttpError(404, "NOT_FOUND", "未知组件");
    const channel =
      request.query.channel === "stable"
        ? "stable"
        : parseReleaseVersion(APP_VERSION)?.rc !== null
          ? "rc"
          : "stable";
    try {
      const latest = await latestRelease(component, channel);
      response.json({
        current_version: APP_VERSION,
        channel,
        update_available: compareReleaseVersions(latest.version, APP_VERSION) > 0,
        latest,
      });
    } catch {
      throw new HttpError(503, "UPDATE_CHECK_UNAVAILABLE", "暂时无法检查版本");
    }
  }),
);
export { router as publicV2Router };
