import { Router } from "express";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { asyncHandler, HttpError } from "../http.js";
import { apiCapabilities } from "../api-capabilities.js";
import { APP_VERSION } from "../version.js";

type ReleaseMetadata = {
  version: string;
  platform: "windows";
  architecture: "x64";
  file_name: string;
  size_bytes: number;
  sha256: string;
  released_at: string;
};

const versionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const fileNamePattern = /^HomeTunnel-Windows-\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?-x64\.zip$/;
const githubRepositoryUrl = "https://github.com/ZHanry/home-tunnel-client";
const serverRepositoryUrl = "https://github.com/ZHanry/home-tunnel-server";
const officialVersionPattern = /^v?(\d+)\.(\d+)\.(\d+)$/;

export function officialServerRelease(value: unknown): { version: string; url: string } | null {
  if (!value || typeof value !== "object") return null;
  const release = value as Record<string, unknown>;
  if (
    release.draft !== false ||
    release.prerelease !== false ||
    typeof release.tag_name !== "string"
  )
    return null;
  if (!officialVersionPattern.test(release.tag_name)) return null;
  return {
    version: release.tag_name.replace(/^v/, ""),
    url: `${serverRepositoryUrl}/releases/tag/${encodeURIComponent(release.tag_name)}`,
  };
}

let cachedServerUpdate: { value: { version: string; url: string }; expiresAt: number } | null =
  null;
let serverUpdateFailedAt = 0;
let serverUpdateInFlight: Promise<{ version: string; url: string }> | null = null;

function latestServerUpdate(): Promise<{ version: string; url: string }> {
  if (cachedServerUpdate && cachedServerUpdate.expiresAt > Date.now())
    return Promise.resolve(cachedServerUpdate.value);
  if (serverUpdateFailedAt + 30_000 > Date.now())
    return Promise.reject(new HttpError(503, "UPDATE_CHECK_UNAVAILABLE", "暂时无法检查正式版本"));
  if (serverUpdateInFlight) return serverUpdateInFlight;
  const operation = (async () => {
    try {
      const response = await fetch(
        "https://api.github.com/repos/ZHanry/home-tunnel-server/releases/latest",
        {
          headers: { accept: "application/vnd.github+json", "user-agent": "home-tunnel-server" },
          signal: AbortSignal.timeout(6_000),
        },
      );
      if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 1_000_000)
        throw new Error("release lookup failed");
      const raw = await response.text();
      if (raw.length > 1_000_000) throw new Error("release metadata too large");
      const release = officialServerRelease(JSON.parse(raw));
      if (!release) throw new Error("not an official stable release");
      cachedServerUpdate = { value: release, expiresAt: Date.now() + 600_000 };
      return release;
    } catch {
      serverUpdateFailedAt = Date.now();
      throw new HttpError(503, "UPDATE_CHECK_UNAVAILABLE", "暂时无法检查正式版本");
    }
  })();
  serverUpdateInFlight = operation;
  void operation
    .finally(() => {
      if (serverUpdateInFlight === operation) serverUpdateInFlight = null;
    })
    .catch(() => {});
  return operation;
}

function unavailable(): HttpError {
  return new HttpError(404, "RELEASE_UNAVAILABLE", "Windows 图形客户端暂不可用");
}

async function latestRelease(): Promise<ReleaseMetadata> {
  try {
    const metadataPath = join(config.downloadsDirectory, "latest.json");
    const parsed = JSON.parse(await readFile(metadataPath, "utf8")) as Partial<ReleaseMetadata>;
    if (
      typeof parsed.version !== "string" ||
      !versionPattern.test(parsed.version) ||
      parsed.platform !== "windows" ||
      parsed.architecture !== "x64" ||
      typeof parsed.file_name !== "string" ||
      !fileNamePattern.test(parsed.file_name) ||
      parsed.file_name !== `HomeTunnel-Windows-${parsed.version}-x64.zip` ||
      !Number.isSafeInteger(parsed.size_bytes) ||
      (parsed.size_bytes ?? 0) <= 0 ||
      typeof parsed.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(parsed.sha256) ||
      typeof parsed.released_at !== "string" ||
      Number.isNaN(Date.parse(parsed.released_at))
    ) {
      throw unavailable();
    }
    return parsed as ReleaseMetadata;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw unavailable();
  }
}

let cachedRelease: { value: ReleaseMetadata; expiresAt: number } | null = null;

async function cachedLatestRelease(): Promise<ReleaseMetadata> {
  if (cachedRelease && cachedRelease.expiresAt > Date.now()) return cachedRelease.value;
  const value = await latestRelease();
  cachedRelease = { value, expiresAt: Date.now() + 5_000 };
  return value;
}

function releaseEtag(release: ReleaseMetadata): string {
  return `"${release.version}-${release.sha256.slice(0, 16)}"`;
}

const publicRouter = Router();

publicRouter.get("/capabilities", (_request, response) => {
  response.setHeader("cache-control", "public, max-age=300, must-revalidate");
  response.json(apiCapabilities);
});

publicRouter.get(
  "/updates/server",
  asyncHandler(async (_request, response) => {
    response.setHeader("cache-control", "no-store");
    response.json({ current_version: APP_VERSION, latest: await latestServerUpdate() });
  }),
);

publicRouter.get("/config", (_request, response) => {
  response.setHeader("cache-control", "public, max-age=300, must-revalidate");
  response.json({
    public_base_url: config.publicBaseUrl,
    tunnel_domain: config.tunnelDomain,
    subdomain_prefix_policy: config.subdomainPrefixPolicy,
    frps_host: config.publicFrpsHost,
    frps_port: config.publicFrpsPort,
    // 未配置 FRPS 证书时该字段不出现，旧客户端与旧部署行为不变。
    ...(config.frpsTlsCertificatePem === null
      ? {}
      : { frps_tls_certificate_pem: config.frpsTlsCertificatePem }),
  });
});

publicRouter.get(
  "/releases/latest",
  asyncHandler(async (request, response) => {
    const release = await cachedLatestRelease();
    const etag = releaseEtag(release);
    response.setHeader("cache-control", "public, max-age=5, must-revalidate");
    response.setHeader("etag", etag);
    if (
      (request.header("if-none-match") ?? "")
        .split(",")
        .map((value) => value.trim())
        .includes(etag)
    ) {
      response.status(304).end();
      return;
    }
    response.json({
      version: release.version,
      platform: release.platform,
      architecture: release.architecture,
      file_name: release.file_name,
      size_bytes: release.size_bytes,
      sha256: release.sha256,
      released_at: release.released_at,
      download_url: `${githubRepositoryUrl}/releases/download/v${encodeURIComponent(release.version)}/${encodeURIComponent(release.file_name)}`,
      stable_download_url: `${githubRepositoryUrl}/releases/latest`,
    });
  }),
);

const downloadRouter = Router();

async function sendRelease(
  response: Parameters<Parameters<typeof asyncHandler>[0]>[1],
  release: ReleaseMetadata,
  stable: boolean,
): Promise<void> {
  response.setHeader("cache-control", stable ? "no-store" : "public, max-age=31536000, immutable");
  response.redirect(
    302,
    `${githubRepositoryUrl}/releases/download/v${encodeURIComponent(release.version)}/${encodeURIComponent(release.file_name)}`,
  );
}

downloadRouter.get(
  "/HomeTunnel-Windows-x64.zip",
  asyncHandler(async (_request, response) =>
    sendRelease(response, await cachedLatestRelease(), true),
  ),
);

downloadRouter.get(
  "/:fileName",
  asyncHandler(async (request, response) => {
    const release = await cachedLatestRelease();
    if (request.params.fileName !== release.file_name) throw unavailable();
    await sendRelease(response, release, false);
  }),
);

export { downloadRouter, publicRouter };
