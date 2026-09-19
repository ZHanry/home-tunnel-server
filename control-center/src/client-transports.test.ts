import { validateApiResponse } from "./api-contract-test-helper.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";

test("client transports require permission, allocate ports atomically and preserve device ownership", async () => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    SQLITE_PATH: ":memory:",
    COOKIE_SECURE: "false",
    INTERNAL_SERVICE_KEY: "11".repeat(32),
    FRPS_PLUGIN_KEY: "22".repeat(32),
    LEASE_SIGNING_KEY: "33".repeat(32),
    TCP_TUNNEL_ENABLED: "true",
    UDP_TUNNEL_ENABLED: "true",
    TCP_PORT_START: "32100",
    TCP_PORT_END: "32102",
    UDP_PORT_START: "32100",
    UDP_PORT_END: "32102",
  });
  const { migrate, transaction, closeDatabase } = await import("./db.js");
  const { issueSession } = await import("./http.js");
  const { createApplication } = await import("./server.js");
  await migrate();
  const owner = randomUUID(),
    user = randomUUID(),
    adminDevice = randomUUID(),
    first = randomUUID(),
    second = randomUUID();
  const sessions = await transaction(async (client) => {
    for (const [id, name, role] of [
      [owner, "owner", "admin"],
      [user, "family", "user"],
    ]) {
      await client.query(
        "INSERT INTO users(id,username,display_name,password_hash,password_state,role) VALUES(?,?,?,'fixture','normal',?)",
        [id, name, name, role],
      );
      await client.query(
        "INSERT INTO traffic_policies(id,scope_type,scope_id) VALUES(?,'user',?)",
        [randomUUID(), id],
      );
    }
    for (const [id, userId] of [
      [adminDevice, owner],
      [first, user],
      [second, user],
    ])
      await client.query(
        "INSERT INTO devices(id,user_id,name,install_id,fingerprint_hash,credential_hash) VALUES(?,?,?,?,?,?)",
        [id, userId, id, id, id, id],
      );
    return {
      owner: await issueSession(client, { id: owner, token_version: 1 }, null),
      adminDevice: await issueSession(client, { id: owner, token_version: 1 }, adminDevice),
      first: await issueSession(client, { id: user, token_version: 1 }, first),
      second: await issueSession(client, { id: user, token_version: 1 }, second),
    };
  });
  const server = (await createApplication(false)).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}/api/v1`;
  async function call(method: string, path: string, token: string, body?: unknown) {
    const response = await fetch(origin + path, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = response.status === 204 ? null : await response.json();
    validateApiResponse(method, "/api/v1" + path, response.status, data);
    return { status: response.status, data };
  }
  const input = (device: string, type = "tcp") => ({
    device_id: device,
    name: "Camera",
    proxy_type: type,
    local_scheme: "http",
    local_host: "127.0.0.1",
    local_port: 554,
    enabled: true,
  });
  try {
    const token = sessions.first.accessToken,
      manager = sessions.owner.accessToken,
      admin = sessions.adminDevice.accessToken;
    const capabilities = (await call("GET", "/client/connections", token)).data.capabilities;
    assert.equal(capabilities.supported, true);
    assert.equal(capabilities.tcp.enabled, true);
    assert.equal(capabilities.tcp.can_create, false);
    assert.equal((await call("POST", "/client/connections", token, input(first))).status, 403);
    assert.equal(
      (
        await call("POST", "/client/connections", admin, {
          ...input(adminDevice),
          remote_port: 32100,
        })
      ).status,
      400,
    );
    assert.equal(
      (await call("PATCH", "/admin/settings", admin, { client_raw_tunnels_enabled: true })).status,
      403,
    );
    const camera = await call("POST", "/client/connections", admin, {
      ...input(adminDevice),
      application_protocol: "rtsp",
    });
    assert.equal(camera.status, 201);
    assert.equal(camera.data.proxy_type, "tcp");
    assert.equal(camera.data.remote_port, 32100);
    assert.equal(camera.data.application_protocol, "rtsp");
    assert.match(camera.data.access_url, /^rtsp:\/\/.+:32100$/);
    assert.equal(camera.data.public_url, null);
    assert.equal(
      (
        await call("PATCH", "/admin/settings", manager, {
          client_raw_tunnels_enabled: true,
          subdomain_prefix_policy: "enforce",
        })
      ).status,
      200,
    );
    const created = await Promise.all([
      call("POST", "/client/connections", token, input(first)),
      call("POST", "/client/connections", sessions.second.accessToken, input(second)),
    ]);
    assert.ok(created.every((value) => value.status === 201));
    assert.deepEqual(created.map((value) => value.data.remote_port).sort(), [32101, 32102]);
    assert.ok(created.every((value) => value.data.subdomain.startsWith("family-")));
    assert.equal(
      (await call("POST", "/client/connections", token, input(first))).data.error_code,
      "PORT_POOL_EXHAUSTED",
    );
    assert.equal(
      (await call("POST", "/client/connections", token, input(second, "udp"))).status,
      404,
    );
    const udp = await call("POST", "/client/connections", token, input(first, "udp"));
    assert.equal(udp.status, 201);
    assert.equal(udp.data.proxy_type, "udp");
    assert.equal(udp.data.remote_port, 32100);
    assert.equal(
      (
        await call("POST", "/client/connections", token, {
          ...input(first, "udp"),
          application_protocol: "rtsp",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call("DELETE", `/client/connections/${camera.data.id}`, admin, {
          expected_version: camera.data.version,
        })
      ).status,
      204,
    );
    const reused = await call("POST", "/client/connections", token, input(first));
    assert.equal(reused.status, 201);
    assert.equal(reused.data.remote_port, 32100);
    const own = (await call("GET", "/client/connections", token)).data.items;
    assert.ok(own.every((item: { device_id: string }) => item.device_id === first));
    assert.equal(
      (await call("PATCH", "/admin/settings", manager, { client_raw_tunnels_enabled: false }))
        .status,
      200,
    );
    assert.equal(
      (await call("POST", "/client/connections", token, input(first, "udp"))).status,
      403,
    );
    assert.equal(
      (
        await call("PATCH", `/client/connections/${udp.data.id}`, token, {
          enabled: false,
          expected_version: udp.data.version,
        })
      ).status,
      200,
    );
  } finally {
    server.close();
    await once(server, "close");
    await closeDatabase();
  }
});
