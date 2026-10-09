import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ASSET_VERSION } from "./version.js";

function request(
  url: string,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  headers: import("node:http").IncomingHttpHeaders;
  body: Buffer;
}> {
  return new Promise((resolvePromise, rejectPromise) => {
    const outgoing = get(url, { headers: { connection: "close", ...headers } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () =>
        resolvePromise({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    outgoing.on("error", rejectPromise);
  });
}

test("public landing page stays available while Windows release metadata is absent", async () => {
  const downloads = await mkdtemp(join(tmpdir(), "home-tunnel-public-test-"));

  const frpsCertificatePem =
    "-----BEGIN CERTIFICATE-----\ntest-only-frps-certificate\n-----END CERTIFICATE-----\n";
  const frpsCertificatePath = join(downloads, "frps_tls_cert.pem");
  await writeFile(frpsCertificatePath, frpsCertificatePem);

  process.env.NODE_ENV = "test";
  process.env.DOWNLOADS_DIRECTORY = downloads;
  process.env.SQLITE_PATH = ":memory:";
  process.env.INTERNAL_SERVICE_KEY ??= "11".repeat(32);
  process.env.FRPS_PLUGIN_KEY ??= "22".repeat(32);
  process.env.LEASE_SIGNING_KEY ??= "33".repeat(32);
  process.env.COOKIE_SECURE = "false";
  // config.ts 在模块加载时求值，必须在 import server.js 之前设置。
  process.env.FRPS_TLS_CERT_FILE = frpsCertificatePath;

  const [{ createApplication }, { closeDatabase }] = await Promise.all([
    import("./server.js"),
    import("./db.js"),
  ]);
  const { officialServerRelease } = await import("./routes/public.js");
  assert.deepEqual(officialServerRelease({ tag_name: "v8.1.0", draft: false, prerelease: false }), {
    version: "8.1.0",
    url: "https://github.com/ZHanry/home-tunnel-server/releases/tag/v8.1.0",
  });
  assert.equal(
    officialServerRelease({ tag_name: "v8.1.0-rc.1", draft: false, prerelease: true }),
    null,
  );
  assert.equal(officialServerRelease({ tag_name: "v8.1.0", draft: true, prerelease: false }), null);
  assert.equal(
    officialServerRelease({ tag_name: "v8.1.0-rc.1", draft: false, prerelease: false }),
    null,
  );
  const app = await createApplication(false);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const landing = await request(origin + "/", { cookie: "ht_access=revoked-session" });
    assert.equal(landing.status, 200);
    assert.equal(landing.headers["cache-control"], "no-cache");
    assert.match(landing.body.toString("utf8"), /桌面图形客户端/);
    assert.match(landing.body.toString("utf8"), /Linux 图形客户端/);
    assert.doesNotMatch(landing.body.toString("utf8"), /内部测试|Experimental|Beta/);
    assert.match(
      landing.body.toString("utf8"),
      /href="https:\/\/github\.com\/ZHanry\/home-tunnel-client\/releases\/tag\/v13\.0\.0"/,
    );
    assert.match(landing.body.toString("utf8"), /id="features"/);
    assert.doesNotMatch(landing.body.toString("utf8"), /home-tunnel\/releases\/latest\/download/);
    assert.doesNotMatch(
      landing.body.toString("utf8"),
      /home-tunnel-client status|macOS|CLI|HEADLESS/,
    );
    assert.ok(landing.body.toString("utf8").includes(`app.js?v=${ASSET_VERSION}`));
    assert.match(landing.body.toString("utf8"), /type="module"/);
    assert.ok(landing.body.toString("utf8").includes(`console.css?v=${ASSET_VERSION}`));
    assert.ok(landing.body.toString("utf8").includes(`theme.js?v=${ASSET_VERSION}`));
    assert.match(landing.body.toString("utf8"), /data-locale-toggle/);
    assert.doesNotMatch(landing.body.toString("utf8"), /实时同步正常|系统健康|受管请求路径/);
    assert.match(landing.body.toString("utf8"), /id="page-actions"/);
    assert.match(
      landing.body.toString("utf8"),
      /href="https:\/\/github\.com\/ZHanry\/home-tunnel">GitHub<\/a>/,
    );

    const publicConfig = await request(origin + "/api/v1/public/config");
    assert.equal(publicConfig.status, 200);
    const publicConfigValue = JSON.parse(publicConfig.body.toString("utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(publicConfigValue.tunnel_domain, "tunnel.example.com");
    assert.equal(publicConfigValue.public_base_url, "https://console.tunnel.example.com");
    assert.equal(publicConfigValue.frps_host, "203.0.113.10");
    assert.equal(publicConfigValue.frps_port, 7000);
    assert.equal(publicConfigValue.frps_tls_certificate_pem, frpsCertificatePem);

    const stylesheet = await request(origin + "/console.css?v=7.0.0");
    assert.equal(stylesheet.status, 200);
    assert.equal(stylesheet.headers["cache-control"], "no-cache");
    // Revalidation stays cheap: an unchanged asset answers 304 without a body.
    const revalidated = await request(origin + "/console.css?v=7.0.0", {
      "if-none-match": String(stylesheet.headers.etag),
    });
    assert.equal(revalidated.status, 304);

    const themeScript = await request(origin + "/theme.js?v=7.0.0");
    assert.equal(themeScript.status, 200);
    assert.match(themeScript.body.toString("utf8"), /ht_locale/);

    const applicationScript = await request(origin + "/app.js?v=7.0.0");
    assert.equal(applicationScript.status, 200);
    assert.ok(
      applicationScript.body.toString("utf8").includes(`./modules/api.js?v=${ASSET_VERSION}`),
    );
    assert.ok(
      applicationScript.body.toString("utf8").includes(`./modules/locale.js?v=${ASSET_VERSION}`),
    );
    assert.ok(
      applicationScript.body.toString("utf8").includes(`./modules/realtime.js?v=${ASSET_VERSION}`),
    );
    assert.match(applicationScript.body.toString("utf8"), /toLocaleString\(localeTag\(\)/);
    assert.equal(applicationScript.headers["cache-control"], "no-cache");
    const deviceScript = await request(origin + "/modules/devices.js?v=7.0.0");
    assert.equal(deviceScript.status, 200);
    assert.match(deviceScript.body.toString("utf8"), /data-action="delete-device"/);
    assert.match(
      applicationScript.body.toString("utf8"),
      /凭据、会话、租约、连接和流量明细将被删除/,
    );
    assert.match(applicationScript.body.toString("utf8"), /api\/v1\/admin\/system\/health/);
    assert.match(deviceScript.body.toString("utf8"), /安装客户端并登录/);
    assert.match(applicationScript.body.toString("utf8"), /TCP（RTSP \/ SSH \/ RDP \/ 数据库等）/);
    assert.match(applicationScript.body.toString("utf8"), /UDP（固定端口）/);
    assert.doesNotMatch(applicationScript.body.toString("utf8"), /data-action="revoke-device"/);

    const localeModule = await request(origin + "/modules/locale.js?v=7.0.0");
    assert.equal(localeModule.status, 200);
    assert.match(localeModule.body.toString("utf8"), /const zhToEn =/);
    assert.match(localeModule.body.toString("utf8"), /Switch to English/);
    assert.match(localeModule.body.toString("utf8"), /function updateDocumentMetadata\(\)/);
    assert.match(
      localeModule.body.toString("utf8"),
      /nestlink — Secure access to services at home/,
    );
    assert.match(localeModule.body.toString("utf8"), /record\.type === "characterData"/);
    assert.equal(localeModule.headers["cache-control"], "no-cache");

    const unversionedModule = await request(origin + "/modules/remote/session.js");
    assert.equal(unversionedModule.status, 200);
    assert.equal(unversionedModule.headers["cache-control"], "no-cache");

    const realtimeModule = await request(origin + "/modules/realtime.js?v=7.0.0");
    assert.equal(realtimeModule.status, 200);
    assert.match(realtimeModule.body.toString("utf8"), /config\.version\.changed/);
    assert.match(realtimeModule.body.toString("utf8"), /export function disconnectRealtime/);

    const admin = await request(origin + "/admin");
    assert.equal(admin.status, 200);
    assert.match(admin.body.toString("utf8"), /id="auth-screen"/);

    for (const path of [
      "/api/v1/public/releases/latest",
      "/downloads/HomeTunnel-Windows-x64.zip",
      "/downloads/HomeTunnel-Windows-9.9.9-x64.zip",
    ]) {
      const unavailable = await request(origin + path, { cookie: "ht_access=revoked-session" });
      assert.equal(unavailable.status, 404);
      assert.match(unavailable.body.toString("utf8"), /RELEASE_UNAVAILABLE/);
    }
  } finally {
    server.close();
    await once(server, "close");
    await closeDatabase();
    await rm(downloads, { recursive: true, force: true });
  }
});
