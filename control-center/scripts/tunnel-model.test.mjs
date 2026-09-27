import test from "node:test";
import assert from "node:assert/strict";
import { serviceTemplates, tunnelVerification } from "../public/modules/tunnel-model.js";

test("templates cover editable web targets and raw application transports", () => {
  assert.deepEqual(
    serviceTemplates.map((item) => item.id),
    [
      "http",
      "https",
      "nas",
      "home-assistant",
      "immich",
      "jellyfin",
      "ssh",
      "rdp",
      "rtsp",
      "tcp",
      "udp",
    ],
  );
  for (const item of serviceTemplates) assert.ok(item.port >= 1 && item.port <= 65535);
  assert.equal(serviceTemplates.find((item) => item.id === "https").scheme, "https");
  assert.equal(serviceTemplates.find((item) => item.id === "rtsp").application, "rtsp");
});
test("saved and online tunnels do not imply a verified device-local service", () => {
  const connection = { enabled: true, version: 2, applied_version: 1, state: "Pending" };
  const device = { online: true };
  assert.equal(tunnelVerification(connection, device).state, "pending");
  connection.state = "Online";
  connection.applied_version = 2;
  assert.equal(tunnelVerification(connection, device).state, "pending");
  connection.diagnostic = { source: "server", target: "device_local", failure: "none" };
  assert.equal(tunnelVerification(connection, device).state, "pending");
  connection.diagnostic.source = "agent";
  assert.equal(tunnelVerification(connection, device).state, "verified");
  device.online = false;
  assert.equal(tunnelVerification(connection, device).state, "offline");
  connection.enabled = false;
  assert.equal(tunnelVerification(connection, device).state, "paused");
});
test("target DNS TLS permission ports and sync errors remain distinct", () => {
  const messages = new Set();
  for (const failure of [
    "dns",
    "tls",
    "target_unreachable",
    "permission",
    "sync",
    "port_unavailable",
    "udp_unreachable",
  ]) {
    const result = tunnelVerification(
      { enabled: true, diagnostic: { source: "agent", target: "device_local", failure } },
      { online: true },
    );
    assert.equal(result.state, "error");
    messages.add(result.message);
  }
  assert.equal(messages.size, 7);
});
