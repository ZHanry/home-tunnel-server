import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.SQLITE_PATH = ":memory:";
process.env.COOKIE_SECURE = "false";
process.env.INTERNAL_SERVICE_KEY = "11".repeat(32);
process.env.FRPS_PLUGIN_KEY = "22".repeat(32);
process.env.LEASE_SIGNING_KEY = "33".repeat(32);

const { agentNative, assertCapabilityReport, assertSessionFeatures } =
  await import("./capabilities.js");
const { accessModeFor, connectionStateFor, failureView } = await import("./connection-state.js");
type CapabilityReport = import("./capabilities.js").CapabilityReport;

const host = { kind: "desktop", role: "host" };

function report(overrides: Partial<CapabilityReport> = {}): CapabilityReport {
  return {
    permissions: ["view", "audio.system", "files.send"],
    unattended_enabled: false,
    displays: [
      {
        id: "display-1",
        name: "Main",
        width: 1920,
        height: 1080,
        dpi_x: 144,
        dpi_y: 144,
        scale_percent: 150,
      },
    ],
    codecs: ["H264"],
    status: "ready",
    native: agentNative(),
    ...overrides,
  };
}

test("native discovery accepts consistent DPI and rejects contradictions", () => {
  assert.doesNotThrow(() => assertCapabilityReport(host, report()));
  assert.throws(
    () =>
      assertCapabilityReport(
        host,
        report({
          displays: [
            {
              id: "display-1",
              name: "Main",
              width: 1920,
              height: 1080,
              dpi_x: 96,
              scale_percent: 150,
            },
          ],
        }),
      ),
    { errorCode: "RD_CAPABILITY_UNSUPPORTED" },
  );
  assert.throws(
    () =>
      assertCapabilityReport(
        host,
        report({
          native: agentNative({ system_audio: "unavailable" }),
        }),
      ),
    { errorCode: "RD_CAPABILITY_UNSUPPORTED" },
  );
  assert.throws(
    () =>
      assertCapabilityReport(host, report({ native: { ...agentNative(), reporter: "browser" } })),
    { errorCode: "RD_CAPABILITY_UNSUPPORTED" },
  );
});

test("audio and files require a discovered backend even when a server flag would allow remote desktop", () => {
  const legacy = report({ native: undefined });
  assert.doesNotThrow(() => assertCapabilityReport(host, legacy));
  assert.throws(() => assertSessionFeatures(legacy, ["view", "audio.system"]), {
    errorCode: "RD_CAPABILITY_UNSUPPORTED",
  });
  assert.throws(() => assertSessionFeatures(legacy, ["files.receive"]), {
    errorCode: "RD_CAPABILITY_UNSUPPORTED",
  });
  assert.doesNotThrow(() => assertSessionFeatures(legacy, ["view", "clipboard.read"]));
  assert.doesNotThrow(() =>
    assertSessionFeatures(report(), ["view", "audio.system", "files.send"]),
  );
});

test("access modes and failure actions stay typed", () => {
  assert.equal(accessModeFor("persistent", null), "unattended");
  assert.equal(accessModeFor("one_session", "temporary_password"), "one_time_password");
  assert.equal(accessModeFor("one_session", "fixed_password"), "fixed_password");
  assert.equal(accessModeFor("one_session", "approved_request"), "local_approval");
  assert.equal(accessModeFor("one_session", null), "local_approval");
  const failure = failureView("RD_NO_DIRECT_PATH");
  assert.equal(failure?.retryable, true);
  assert.equal(failure?.action, "check_udp_path");
  assert.equal(connectionStateFor("active", null).phase, "active");
  assert.equal(connectionStateFor("closing", failure).retryable, true);
  assert.equal(failureView("RD_NOT_A_REAL_CODE")?.retryable, false);
});
