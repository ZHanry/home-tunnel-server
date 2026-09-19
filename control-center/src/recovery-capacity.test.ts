import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { validateApiResponse } from "./api-contract-test-helper.js";

test("offline recovery revokes sessions; paginated 10/100/1000 resource baselines", async () => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    SQLITE_PATH: ":memory:",
    INTERNAL_SERVICE_KEY: "11".repeat(32),
    FRPS_PLUGIN_KEY: "22".repeat(32),
    LEASE_SIGNING_KEY: "33".repeat(32),
    COOKIE_SECURE: "false",
    BOOTSTRAP_ADMIN_PASSWORD: "Capacity-Bootstrap-Q8-safe",
  });
  const { createApplication } = await import("./server.js");
  const db = await import("./db.js");
  const { recoverAdministrator } = await import("./recover-admin.js");
  const { hashPassword } = await import("./security.js");
  const server = (await createApplication()).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const password = `Capacity-${randomUUID()}-safe`;
  async function call(method: string, path: string, token?: string, body?: unknown) {
    const response = await fetch(origin + "/api/v1" + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = response.status === 204 ? null : await response.json();
    validateApiResponse(method, "/api/v1" + path, response.status, data);
    return { status: response.status, data };
  }
  try {
    await db.query(
      "UPDATE users SET password_hash=?,password_state='normal',temporary_password_expires_at=NULL WHERE role='admin'",
      [await hashPassword(password)],
    );
    const login = await call("POST", "/auth/login", undefined, {
      username: "admin",
      password,
      client_type: "linux",
    });
    assert.equal(login.status, 200);
    const token = login.data.access_token;
    const userId = login.data.user.id;
    const devices = Array.from({ length: 5 }, () => randomUUID());
    await db.transaction(async (client) => {
      for (const [index, id] of devices.entries())
        await client.query(
          "INSERT INTO devices(id,user_id,name,install_id,fingerprint_hash,credential_hash) VALUES(?,?,?,?,?,?)",
          [id, userId, `Capacity ${index}`, randomUUID(), String(index).repeat(64), "fixture"],
        );
    });
    let inserted = 0;
    for (const size of [10, 100, 1000]) {
      await db.transaction(async (client) => {
        for (; inserted < size; inserted++)
          await client.query(
            "INSERT INTO connections(id,user_id,device_id,name,subdomain,local_scheme,local_host,local_port) VALUES(?,?,?,?,?,'http','127.0.0.1',8080)",
            [
              randomUUID(),
              userId,
              devices[Math.floor(inserted / 200)],
              `Capacity ${inserted}`,
              `capacity-${inserted}`,
            ],
          );
      });
      const timings: number[] = [];
      let bytes = 0;
      for (let run = 0; run < 5; run++) {
        const started = performance.now();
        const listed = await call("GET", "/client/connections?page_size=100", token);
        timings.push(performance.now() - started);
        assert.equal(listed.status, 200);
        assert.equal(listed.data.total, size);
        assert.equal(listed.data.items.length, Math.min(100, size));
        bytes = Buffer.byteLength(JSON.stringify(listed.data));
        assert.ok(bytes < 2 * 1024 * 1024);
      }
      timings.sort((a, b) => a - b);
      console.log(
        JSON.stringify({
          benchmark: "sqlite-api-page",
          connections: size,
          page_size: 100,
          samples: 5,
          median_ms: Number(timings[2]!.toFixed(2)),
          max_ms: Number(timings[4]!.toFixed(2)),
          response_bytes: bytes,
        }),
      );
    }
    const allIds = new Set<string>();
    for (let page = 1; page <= 10; page++) {
      const result = await call("GET", `/client/connections?page=${page}&page_size=100`, token);
      for (const item of result.data.items) allIds.add(item.id);
    }
    assert.equal(allIds.size, 1000);
    assert.equal((await call("GET", "/client/connections?page_size=101", token)).status, 400);
    const limited = await call("POST", "/client/connections", token, {
      name: "over limit",
      device_id: devices[0],
      subdomain: "admin-over-limit",
      local_scheme: "http",
      local_host: "127.0.0.1",
      local_port: 8080,
    });
    assert.equal(limited.status, 409);
    assert.equal(limited.data.error_code, "RESOURCE_LIMIT");
    const capabilities = await call("GET", "/public/capabilities");
    assert.equal(capabilities.data.limits.page_size, 100);
    const code = await call("POST", "/client/enrollment-codes", token, {
      name: "revoked by recovery",
    });
    assert.equal(code.status, 201);
    const recovered = await recoverAdministrator();
    assert.equal(recovered.username, "admin");
    assert.ok(Date.parse(recovered.expires_at) > Date.now());
    assert.equal((await call("GET", "/auth/me", token)).status, 401);
    assert.equal(
      (
        await call("POST", "/auth/login", undefined, {
          username: "admin",
          password,
          client_type: "linux",
        })
      ).status,
      401,
    );
    const temporary = await call("POST", "/auth/login", undefined, {
      username: "admin",
      password: recovered.temporary_password,
      client_type: "linux",
    });
    assert.equal(temporary.status, 200);
    assert.equal(temporary.data.password_change_required, true);
    assert.equal(
      (await call("GET", "/client/connections", temporary.data.access_token)).status,
      423,
    );
    const stored = await db.one<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM enrollment_codes WHERE id=?",
      [code.data.id],
    );
    assert.ok(stored?.revoked_at);
    const audit = JSON.stringify(
      await db.query("SELECT * FROM audit_events WHERE action='AdministratorRecoveredOffline'"),
    );
    assert.ok(!audit.includes(recovered.temporary_password));
    assert.ok(audit.includes("AdministratorRecoveredOffline"));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await db.closeDatabase();
  }
});
