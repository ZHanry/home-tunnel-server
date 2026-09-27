import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.SQLITE_PATH = ":memory:";
process.env.COOKIE_SECURE = "false";
process.env.INTERNAL_SERVICE_KEY = "11".repeat(32);
process.env.FRPS_PLUGIN_KEY = "22".repeat(32);
process.env.LEASE_SIGNING_KEY = "33".repeat(32);

const { normalizeAgentDiagnostic } = await import("./tunnel-diagnostics.js");

test("tunnel diagnostics come from the device agent and reject unsupported transports", () => {
  const source = readFileSync(new URL("./tunnel-diagnostics.js", import.meta.url), "utf8");
  assert.equal(source.includes("local_host"), false);
  assert.equal(/\b(fetch|dns\.lookup|net\.connect|http\.request)\b/.test(source), false);
  const reported = normalizeAgentDiagnostic(
    {
      source: "agent",
      target: "device_local",
      transport: "http",
      failure: "dns",
      retryable: true,
    },
    { proxy_type: "http", local_scheme: "http" },
  );
  assert.equal(reported.action, "check_target_dns");
  assert.equal(reported.source, "agent");
  assert.throws(
    () =>
      normalizeAgentDiagnostic(
        {
          source: "server",
          target: "device_local",
          transport: "http",
          failure: "dns",
          retryable: true,
        },
        { proxy_type: "http", local_scheme: "http" },
      ),
    { errorCode: "TUNNEL_DIAGNOSTIC_REJECTED" },
  );
  assert.throws(
    () =>
      normalizeAgentDiagnostic(
        {
          source: "agent",
          target: "device_local",
          transport: "udp",
          failure: "udp_unreachable",
          retryable: true,
        },
        { proxy_type: "tcp", local_scheme: "http" },
      ),
    { errorCode: "TUNNEL_TRANSPORT_UNSUPPORTED" },
  );
  assert.throws(
    () =>
      normalizeAgentDiagnostic(
        {
          source: "agent",
          target: "device_local",
          transport: "tcp",
          failure: "tls",
          retryable: false,
        },
        { proxy_type: "tcp", local_scheme: "http" },
      ),
    { errorCode: "TUNNEL_TRANSPORT_UNSUPPORTED" },
  );
});
