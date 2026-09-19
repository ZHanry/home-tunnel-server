import { validateApiResponse } from "./api-contract-test-helper.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("console port policies apply to allocation, sync and FRPS, survive restart and protect existing connections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "home-tunnel-transport-"));
  Object.assign(process.env, {
    NODE_ENV: "test",
    SQLITE_PATH: join(directory, "settings.db"),
    COOKIE_SECURE: "false",
    INTERNAL_SERVICE_KEY: "11".repeat(32),
    FRPS_PLUGIN_KEY: "22".repeat(32),
    LEASE_SIGNING_KEY: "33".repeat(32),
    L4_PORT_POOL_ENABLED: "true",
    TCP_TUNNEL_ENABLED: "false",
    UDP_TUNNEL_ENABLED: "false",
    TCP_PORT_START: "32100",
    TCP_PORT_END: "32105",
    UDP_PORT_START: "32100",
    UDP_PORT_END: "32105",
  });
  const { migrate, transaction, closeDatabase } = await import("./db.js");
  const { issueSession } = await import("./http.js");
  const { createApplication } = await import("./server.js");
  const { config } = await import("./config.js");
  await migrate();
  const owner = randomUUID(),
    user = randomUUID(),
    device = randomUUID();
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
    await client.query(
      "INSERT INTO devices(id,user_id,name,install_id,fingerprint_hash,credential_hash) VALUES(?,?,?,?,?,?)",
      [device, owner, "Server", device, device, device],
    );
    return {
      admin: (await issueSession(client, { id: owner, token_version: 1 }, null)).accessToken,
      user: (await issueSession(client, { id: user, token_version: 1 }, null)).accessToken,
      device: (await issueSession(client, { id: owner, token_version: 1 }, device)).accessToken,
    };
  });
  const server = (await createApplication(false)).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  async function call(method: string, path: string, body?: unknown, token = sessions.admin) {
    const response = await fetch(origin + path, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = response.status === 204 ? null : await response.json();
    validateApiResponse(method, path, response.status, data);
    return { status: response.status, data };
  }
  const settings = "/api/v1/admin/settings";
  const policy = (enabled = true, start = 32101, end = 32103) => ({
    enabled,
    port_start: start,
    port_end: end,
  });
  let version = 0;
  const save = (tcp: ReturnType<typeof policy>, token = sessions.admin, extra = {}) =>
    call(
      "PATCH",
      settings,
      { transport_tunnels: { tcp }, transport_settings_version: version, ...extra },
      token,
    );
  const input = {
    device_id: device,
    name: "SSH",
    proxy_type: "tcp",
    local_scheme: "http",
    local_host: "127.0.0.1",
    local_port: 22,
    enabled: true,
    application_protocol: "ssh",
  };
  const sync = () =>
    call(
      "POST",
      "/api/v1/client/sync",
      { device_id: device, last_config_version: 0, supported_proxy_types: ["http", "tcp", "udp"] },
      sessions.device,
    );
  try {
    const initial = (await call("GET", settings)).data;
    assert.equal(initial.transport_settings_version, 0);
    assert.equal(initial.transport_tunnels.tcp.enabled, false);
    assert.equal(initial.transport_tunnels.tcp.deployment_ready, true);
    assert.equal(
      (await call("POST", "/api/v1/client/connections", input, sessions.device)).status,
      403,
    );
    assert.equal((await save(policy(), sessions.user)).status, 403);
    assert.equal((await save(policy(), sessions.device)).status, 403);
    assert.equal(
      (await call("PATCH", settings, { transport_tunnels: { tcp: policy() } })).status,
      400,
    );
    assert.equal((await save(policy(true, 32103, 32101))).status, 400);
    assert.equal(
      (await save(policy(true, 32099, 32103), sessions.admin, { client_raw_tunnels_enabled: true }))
        .status,
      400,
    );
    assert.equal(
      (await call("GET", settings)).data.client_raw_tunnels_enabled,
      false,
      "failed updates must roll back permission changes too",
    );
    config.transportPortPools.tcp = false;
    assert.equal((await save(policy())).data.error_code, "TRANSPORT_POOL_UNAVAILABLE");
    config.transportPortPools.tcp = true;

    const competing = await Promise.all([save(policy()), save(policy())]);
    assert.deepEqual(competing.map((result) => result.status).sort(), [200, 409]);
    version = 1;
    assert.equal(
      (await save(policy())).data.transport_settings_version,
      1,
      "saving unchanged settings is idempotent",
    );
    const created = await call("POST", "/api/v1/client/connections", input, sessions.device);
    assert.equal(created.status, 201);
    assert.equal(created.data.remote_port, 32101);
    const id = created.data.id;
    const adminCatalog = (await call("GET", "/api/v1/admin/connections")).data;
    assert.equal(adminCatalog.transport_tunnels.tcp.port_start, 32101);
    assert.equal(adminCatalog.tcp_tunnels.enabled, true);
    assert.equal(
      (await call("GET", "/api/v1/admin/summary")).data.transport_tunnels.tcp.port_end,
      32103,
    );
    const used = (await call("GET", settings)).data.transport_tunnels.tcp;
    assert.equal(used.allocated_ports, 1);
    assert.equal(used.available_ports, 2);
    assert.equal(used.active_connections, 1);
    assert.equal((await save(policy(false))).data.error_code, "TRANSPORT_CONNECTIONS_ACTIVE");
    assert.equal(
      (await save(policy(true, 32102, 32103))).data.error_code,
      "TRANSPORT_CONNECTIONS_ACTIVE",
    );
    const deniedAdmin = await call("POST", "/api/v1/admin/connections", {
      ...input,
      user_id: owner,
      subdomain: "outside-pool",
      remote_port: 32100,
    });
    assert.equal(deniedAdmin.data.error_code, "TCP_PORT_NOT_ALLOWED");

    const synced = (await sync()).data;
    assert.equal(synced.connections.find((row: { id: string }) => row.id === id).enabled, true);
    const proxyName = synced.connections.find((row: { id: string }) => row.id === id).proxy_name;
    const plugin = async () =>
      call(
        "POST",
        `/internal/frps/plugin/${process.env.FRPS_PLUGIN_KEY}?version=0.1.0&op=NewProxy`,
        {
          version: "0.1.0",
          op: "NewProxy",
          content: {
            user: {
              user: device,
              metas: { home_tunnel_lease: synced.lease.lease },
              run_id: "transport-settings",
            },
            proxy_name: `${device}.${proxyName}`,
            proxy_type: "tcp",
            remote_port: 32101,
          },
        },
      );
    assert.equal((await plugin()).data.reject, false);
    // An unprepared or narrowed deployment cannot be bypassed by saved console settings.
    config.transportPortPools.tcp = false;
    assert.equal(
      (await sync()).data.connections.find((row: { id: string }) => row.id === id).enabled,
      false,
    );
    assert.equal((await plugin()).data.reject, true);
    config.transportPortPools.tcp = true;
    config.transportTunnels.tcp.portStart = 32102;
    assert.equal((await call("GET", settings)).data.transport_tunnels.tcp.range_available, false);
    assert.equal((await plugin()).data.reject, true);
    config.transportTunnels.tcp.portStart = 32100;

    const paused = await call(
      "PATCH",
      `/api/v1/client/connections/${id}`,
      { enabled: false, expected_version: created.data.version },
      sessions.device,
    );
    assert.equal(paused.status, 200);
    const narrowed = await save(policy(true, 32102, 32103));
    assert.equal(narrowed.status, 200);
    version = narrowed.data.transport_settings_version;
    const resume = await call(
      "PATCH",
      `/api/v1/client/connections/${id}`,
      { enabled: true, expected_version: paused.data.version },
      sessions.device,
    );
    assert.equal(resume.data.error_code, "TCP_PORT_NOT_ALLOWED");
    const pausedEdit = await call(
      "PATCH",
      `/api/v1/client/connections/${id}`,
      { name: "Paused SSH", expected_version: paused.data.version },
      sessions.device,
    );
    assert.equal(pausedEdit.status, 200, "an excluded paused connection remains manageable");
    const second = await call("POST", "/api/v1/client/connections", input, sessions.device);
    assert.equal(second.data.remote_port, 32102);
    const race = await Promise.all([
      save(policy(true, 32102, 32102)),
      call("POST", "/api/v1/client/connections", input, sessions.device),
    ]);
    assert.ok(
      (race[0].status === 200 && race[1].data.error_code === "PORT_POOL_EXHAUSTED") ||
        (race[0].data.error_code === "TRANSPORT_CONNECTIONS_ACTIVE" && race[1].status === 201),
      "allocation and narrowing must be serialized",
    );
    const current = (await call("GET", settings)).data;
    version = current.transport_settings_version;
    const udp = await call("PATCH", settings, {
      transport_settings_version: version,
      transport_tunnels: { udp: policy(true, 32102, 32102) },
    });
    assert.equal(udp.status, 200);
    const udpCreated = await call(
      "POST",
      "/api/v1/client/connections",
      { ...input, proxy_type: "udp", application_protocol: undefined },
      sessions.device,
    );
    assert.equal(udpCreated.data.remote_port, 32102, "TCP and UDP may use the same port number");
    const audit = await transaction((client) =>
      client.query<{ count: number }>(
        "SELECT count(*) AS count FROM audit_events WHERE action='DeploymentSettingsUpdated'",
      ),
    );
    assert.ok(Number(audit.rows[0]?.count) >= 3);
  } finally {
    server.close();
    await once(server, "close");
    await closeDatabase();
  }
  try {
    const restarted = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      const db = await import(${JSON.stringify(new URL("./db.js", import.meta.url).href)});
      const { transportSettings } = await import(${JSON.stringify(new URL("./transport-settings.js", import.meta.url).href)});
      console.log(JSON.stringify(await db.transaction(transportSettings)));
      await db.closeDatabase();
    `,
      ],
      { env: process.env, encoding: "utf8" },
    );
    assert.equal(restarted.status, 0, restarted.stderr);
    const persisted = JSON.parse(restarted.stdout);
    assert.equal(persisted.transport_tunnels.tcp.enabled, true);
    assert.equal(persisted.transport_tunnels.tcp.port_start, 32102);
    assert.equal(persisted.transport_tunnels.udp.enabled, true);
    assert.ok(persisted.transport_settings_version >= 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
