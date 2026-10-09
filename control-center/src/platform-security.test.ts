import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { validateApiResponse } from "./api-contract-test-helper.js";

test("v2 account sessions, removed authentication APIs and optimistic policy writes", async (t) => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    SQLITE_PATH: ":memory:",
    INTERNAL_SERVICE_KEY: "11".repeat(32),
    FRPS_PLUGIN_KEY: "22".repeat(32),
    LEASE_SIGNING_KEY: "33".repeat(32),
    COOKIE_SECURE: "false",
    BOOTSTRAP_ADMIN_PASSWORD: "Platform-Bootstrap-Q8-safe",
  });
  const { createApplication } = await import("./server.js");
  const db = await import("./db.js");
  const server = (await createApplication()).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  let loginNumber = 0;
  async function call(
    method: string,
    path: string,
    body?: unknown,
    token?: string,
    cookie?: string,
    csrf?: string,
  ) {
    const response = await fetch(origin + (path.startsWith("/api/") ? path : "/api/v1" + path), {
      method,
      headers: {
        "content-type": "application/json",
        "user-agent": "platform-test",
        ...(path === "/auth/login" ? { "x-forwarded-for": `192.0.2.${++loginNumber}` } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(cookie ? { cookie } : {}),
        ...(csrf ? { "x-csrf-token": csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = response.status === 204 ? null : await response.json();
    if (!path.startsWith("/api/v2") && response.status !== 404)
      validateApiResponse(method, "/api/v1" + path, response.status, data);
    return {
      status: response.status,
      data,
      cookie: response.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; "),
    };
  }
  const password = "Platform-Normal-S9-safe";
  try {
    const first = await call("POST", "/auth/login", {
      username: "admin",
      password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
      client_type: "linux",
    });
    assert.equal(first.status, 200);
    assert.equal(
      (
        await call(
          "POST",
          "/auth/password/change",
          { current_password: process.env.BOOTSTRAP_ADMIN_PASSWORD, new_password: password },
          first.data.access_token,
        )
      ).status,
      204,
    );
    const login = await call("POST", "/auth/login", {
      username: "admin",
      password,
      client_type: "linux",
    });
    const token = login.data.access_token;
    assert.ok(
      (
        await db.one<{ rd_verified_at: Date }>(
          "SELECT rd_verified_at FROM sessions WHERE access_token_hash=?",
          [(await import("./security.js")).tokenHash(token)],
        )
      )?.rd_verified_at,
    );
    await t.test(
      "web tabs share CSRF and retry the same rotation; later replay revokes",
      async () => {
        const web = await call("POST", "/auth/login", {
          username: "admin",
          password,
          client_type: "web",
        });
        const existing = await call("GET", "/auth/session", undefined, undefined, web.cookie);
        assert.equal(existing.data.csrf_token, web.data.csrf_token);
        assert.equal(existing.cookie, "");
        const rotations = await Promise.all(
          [1, 2].map(() =>
            call("POST", "/auth/refresh", { client_type: "web" }, undefined, web.cookie),
          ),
        );
        assert.deepEqual(
          rotations.map((r) => r.status),
          [200, 200],
        );
        assert.equal(rotations[0]!.cookie, rotations[1]!.cookie);
        assert.equal(rotations[0]!.data.csrf_token, web.data.csrf_token);
        const write = await call(
          "POST",
          "/api/v2/auth/devices",
          {
            name: "tab one",
            install_id: randomUUID(),
            fingerprint_hash: "cd".repeat(32),
            client_version: "13.0.0",
            client_type: "windows",
            credential_purpose: "gui",
          },
          undefined,
          rotations[0]!.cookie,
          web.data.csrf_token,
        );
        assert.equal(write.status, 201);
        await db.query("UPDATE sessions SET refresh_retry_until_at=? WHERE id=?", [
          new Date(Date.now() - 1000),
          existing.data.session_id,
        ]);
        assert.equal(
          (await call("POST", "/auth/refresh", { client_type: "web" }, undefined, web.cookie))
            .status,
          401,
        );
        assert.equal(
          (await call("GET", "/auth/session", undefined, undefined, rotations[0]!.cookie)).status,
          401,
        );
      },
    );
    await t.test("native refresh replay remains strict", async () => {
      const native = await call("POST", "/auth/login", {
        username: "admin",
        password,
        client_type: "linux",
      });
      assert.equal(
        (
          await call("POST", "/auth/refresh", {
            client_type: "linux",
            refresh_token: native.data.refresh_token,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await call("POST", "/auth/refresh", {
            client_type: "web",
            refresh_token: native.data.refresh_token,
          })
        ).status,
        401,
      );
    });
    let deviceToken = "",
      deviceId = "";
    await t.test("account login registers an independent background device", async () => {
      const enrolled = await call(
        "POST",
        "/api/v2/auth/devices",
        {
          name: "NAS",
          install_id: randomUUID(),
          fingerprint_hash: "ab".repeat(32),
          client_version: "13.0.0",
          client_type: "nas",
          credential_purpose: "background",
        },
        token,
      );
      assert.equal(enrolled.status, 201, JSON.stringify(enrolled.data));
      deviceToken = enrolled.data.access_token;
      deviceId = enrolled.data.device_id;
      assert.equal((await call("GET", "/auth/sessions", undefined, deviceToken)).status, 403);
      assert.equal(
        (
          await call(
            "POST",
            "/api/v2/auth/devices",
            {
              name: "NAS",
              install_id: randomUUID(),
              fingerprint_hash: "ab".repeat(32),
              client_version: "13.0.0",
              client_type: "nas",
              credential_purpose: "background",
            },
            token,
          )
        ).status,
        409,
      );
      assert.equal((await call("POST", "/auth/enroll", { code: "old-code" })).status, 404);
      assert.equal(
        (await call("POST", "/client/enrollment-codes", { name: "old code" }, token)).status,
        404,
      );
    });
    await t.test("ACL conflicts cannot overwrite a policy or restart the device", async () => {
      const created = await call(
        "POST",
        "/client/connections",
        {
          device_id: deviceId,
          name: "Service",
          subdomain: "platform-service",
          local_scheme: "http",
          local_host: "127.0.0.1",
          local_port: 8080,
        },
        deviceToken,
      );
      assert.equal(created.status, 201, JSON.stringify(created.data));
      const id = created.data.id;
      const before = await db.one<{ config_version: number }>(
        "SELECT config_version FROM devices WHERE id=?",
        [deviceId],
      );
      const patch = {
        expected_version: 1,
        expected_access_policy_version: 1,
        access: { ip_allowlist: ["192.0.2.0/24"] },
      };
      const first = await call("PATCH", `/client/connections/${id}`, patch, deviceToken);
      assert.equal(first.status, 200, JSON.stringify(first.data));
      assert.equal(first.data.version, 1);
      assert.equal(first.data.access_policy_version, 2);
      const stale = await call("PATCH", `/client/connections/${id}`, patch, deviceToken);
      assert.equal(stale.status, 409);
      assert.equal(stale.data.error_code, "ACCESS_POLICY_VERSION_CONFLICT");
      assert.equal(
        (
          await db.one<{ config_version: number }>(
            "SELECT config_version FROM devices WHERE id=?",
            [deviceId],
          )
        )?.config_version,
        before?.config_version,
      );
      const batch = await call(
        "POST",
        "/client/connections/batch",
        {
          enabled: false,
          items: [
            { id, expected_version: 1 },
            { id: randomUUID(), expected_version: 1 },
          ],
        },
        deviceToken,
      );
      assert.equal(batch.status, 200);
      assert.deepEqual(
        batch.data.results.map((r: { status: number }) => r.status),
        [200, 404],
      );
      const metadata = {
        tags: ["home", "nas", "home"],
        favorite: true,
        expected_metadata_version: 1,
      };
      assert.equal(
        (await call("PATCH", `/client/devices/${deviceId}/metadata`, metadata, token)).status,
        200,
      );
      assert.equal(
        (await call("PATCH", `/client/devices/${deviceId}/metadata`, metadata, token)).status,
        409,
      );
    });
    await t.test(
      "management sessions can be revoked without revoking independent device credentials",
      async () => {
        for (const route of ["setup", "confirm", "disable"]) {
          assert.equal((await call("POST", "/auth/mfa/" + route, { password }, token)).status, 404);
        }
        const second = await call("POST", "/auth/login", {
          username: "admin",
          password,
          client_type: "linux",
        });
        const sessions = await call("GET", "/auth/sessions", undefined, second.data.access_token);
        assert.ok(sessions.data.items.some((item: { current: boolean }) => item.current));
        const current = sessions.data.items.find((item: { current: boolean }) => item.current);
        assert.equal(
          (await call("DELETE", "/auth/sessions/" + current.id, undefined, token)).status,
          204,
        );
        assert.equal(
          (await call("GET", "/auth/me", undefined, second.data.access_token)).status,
          401,
        );
        assert.equal((await call("GET", "/auth/me", undefined, deviceToken)).status, 200);
      },
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await db.closeDatabase();
  }
});
