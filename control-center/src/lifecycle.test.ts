import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";

test("device sessions stay local and deleting an account revokes its complete resource graph", async () => {
  process.env.NODE_ENV = "test";
  process.env.SQLITE_PATH = ":memory:";
  process.env.COOKIE_SECURE = "false";
  process.env.INTERNAL_SERVICE_KEY = "11".repeat(32);
  process.env.FRPS_PLUGIN_KEY = "22".repeat(32);
  process.env.LEASE_SIGNING_KEY = "33".repeat(32);
  const { createApplication } = await import("./server.js");
  const { migrate, closeDatabase, transaction, one } = await import("./db.js");
  const { issueSession } = await import("./http.js");
  const { createConnection } = await import("./domain.js");
  const { tokenHash, hashPassword } = await import("./security.js");
  await migrate();
  const userId = randomUUID(),
    adminId = randomUUID(),
    firstDevice = randomUUID(),
    secondDevice = randomUUID();
  const adminDevice = randomUUID();
  const credential = "lifecycle-device-credential-" + randomUUID();
  const hash = await hashPassword("Lifecycle-password-S9-long");
  const fixture = await transaction(async (client) => {
    for (const [id, username, role] of [
      [userId, "family", "user"],
      [adminId, "owner", "admin"],
    ]) {
      await client.query(
        "INSERT INTO users(id,username,display_name,password_hash,password_state,role) VALUES(?,?,?,?,'normal',?)",
        [id, username, username, hash, role],
      );
      await client.query(
        "INSERT INTO traffic_policies(id,scope_type,scope_id) VALUES(?,'user',?)",
        [randomUUID(), id],
      );
    }
    for (const [id, owner] of [
      [firstDevice, userId],
      [secondDevice, userId],
      [adminDevice, adminId],
    ])
      await client.query(
        "INSERT INTO devices(id,user_id,name,install_id,fingerprint_hash,credential_hash) VALUES(?,?,?,?,?,?)",
        [id, owner, id, id, id, tokenHash(credential)],
      );
    const first = await createConnection(client, userId, firstDevice, {
      name: "First service",
      proxy_type: "http",
      subdomain: "family-first",
      local_scheme: "http",
      local_host: "127.0.0.1",
      local_port: 8080,
      enabled: true,
    });
    const second = await createConnection(client, userId, secondDevice, {
      name: "Second service",
      proxy_type: "http",
      subdomain: "family-second",
      local_scheme: "http",
      local_host: "127.0.0.1",
      local_port: 8090,
      enabled: true,
    });
    const management = await issueSession(client, { id: userId, token_version: 1 }, null);
    const local = await issueSession(client, { id: userId, token_version: 1 }, firstDevice);
    const admin = await issueSession(client, { id: adminId, token_version: 1 }, null);
    const localAdmin = await issueSession(client, { id: adminId, token_version: 1 }, adminDevice);
    return { first, second, management, local, admin, localAdmin };
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
    return {
      status: response.status,
      data: response.status === 204 ? null : await response.json(),
    };
  }
  try {
    const local = fixture.local.accessToken,
      manager = fixture.management.accessToken,
      admin = fixture.admin.accessToken;
    assert.equal((await call("GET", "/client/connections", manager)).data.items.length, 2);
    const localList = await call("GET", "/client/connections", local);
    assert.deepEqual(
      localList.data.items.map((c: { device_id: string }) => c.device_id),
      [firstDevice],
    );
    assert.deepEqual(
      (await call("GET", "/client/devices", local)).data.items.map((d: { id: string }) => d.id),
      [firstDevice],
    );
    assert.deepEqual(
      new Set(
        (await call("GET", "/client/remote-devices", local)).data.items.map(
          (d: { id: string }) => d.id,
        ),
      ),
      new Set([firstDevice, secondDevice]),
    );
    assert.equal(
      (await call("GET", `/client/remote-devices?user_id=${adminId}`, local)).status,
      403,
    );
    assert.equal((await call("GET", "/admin/users", fixture.localAdmin.accessToken)).status, 403);
    for (const method of ["GET", "PATCH", "DELETE"]) {
      const denied = await call(
        method,
        `/client/connections/${fixture.second.id}`,
        local,
        method === "GET"
          ? undefined
          : { name: "Changed", expected_version: Number(fixture.second.version) },
      );
      assert.equal(denied.status, 404, `Cross-device ${method} must fail`);
    }
    assert.equal(
      (await call("GET", `/client/connections/${fixture.second.id}/custom-domains`, local)).status,
      404,
    );
    assert.equal(
      (
        await call(
          "GET",
          `/client/subdomains/availability?name=family-second&connection_id=${fixture.second.id}`,
          local,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await call("POST", "/client/connections", local, {
          device_id: secondDevice,
          name: "wrong",
          subdomain: "family-wrong",
          local_scheme: "http",
          local_host: "127.0.0.1",
          local_port: 80,
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await call("PATCH", `/client/connections/${fixture.first.id}`, local, {
          enabled: false,
          expected_version: Number(fixture.first.version),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call("PATCH", `/client/connections/${fixture.second.id}`, manager, {
          enabled: false,
          expected_version: Number(fixture.second.version),
        })
      ).status,
      200,
    );
    assert.equal(
      (await call("DELETE", `/admin/users/${adminId}`, admin, { expected_version: 1 })).status,
      409,
    );
    assert.equal(
      (await call("DELETE", `/admin/users/${userId}`, manager, { expected_version: 1 })).status,
      403,
    );
    assert.equal(
      (await call("DELETE", `/admin/users/${userId}`, admin, { expected_version: 999 })).status,
      409,
    );
    assert.equal(
      (await call("DELETE", `/admin/users/${userId}`, admin, { expected_version: 1 })).status,
      204,
    );
    assert.equal((await call("GET", "/client/connections", local)).status, 401);
    assert.equal((await call("GET", "/client/connections", manager)).status, 401);
    assert.equal(
      (
        await call("POST", "/auth/device", "", {
          device_id: secondDevice,
          device_credential: credential,
        })
      ).status,
      423,
    );
    assert.equal((await call("GET", `/admin/users/${userId}`, admin)).status, 404);
    assert.equal((await call("POST", `/admin/users/${userId}/enable`, admin, {})).status, 404);
    assert.equal((await call("GET", "/admin/users", admin)).data.items.length, 1);
    assert.equal(
      (
        await one<{ count: number }>(
          "SELECT count(*) AS count FROM connections WHERE user_id=? AND deleted_at IS NULL",
          [userId],
        )
      )?.count,
      0,
    );
    assert.equal(
      (
        await one<{ count: number }>(
          "SELECT count(*) AS count FROM devices WHERE user_id=? AND status='active'",
          [userId],
        )
      )?.count,
      0,
    );
    assert.equal(
      (
        await one<{ count: number }>(
          "SELECT count(*) AS count FROM audit_events WHERE target_id=? AND action='UserDeleted'",
          [userId],
        )
      )?.count,
      1,
    );
    const reused = await call("POST", "/admin/users", admin, {
      username: "family",
      display_name: "New family account",
    });
    assert.equal(reused.status, 201);
    assert.notEqual(reused.data.user.id, userId);
  } finally {
    server.close();
    await once(server, "close");
    await closeDatabase();
  }
});
