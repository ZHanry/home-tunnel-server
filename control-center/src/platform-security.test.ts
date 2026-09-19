import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { validateApiResponse } from "./api-contract-test-helper.js";

test("7.0 session races, enrollment, MFA and optimistic policy writes", async (t) => {
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
  const { totpCode } = await import("./mfa.js");
  const { sealSecret, openSecret } = await import("./protected-secrets.js");
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
    const response = await fetch(origin + "/api/v1" + path, {
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
          "/client/enrollment-codes",
          { name: "tab one" },
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
    await t.test("enrollment is single use, device scoped and supports revocation", async () => {
      const code = await call("POST", "/client/enrollment-codes", { name: "new computer" }, token);
      assert.equal(code.status, 201);
      const body = {
        code: code.data.code,
        name: "NAS",
        install_id: randomUUID(),
        fingerprint_hash: "ab".repeat(32),
        client_version: "7.0.0",
        client_type: "linux",
      };
      const results = await Promise.all([1, 2].map(() => call("POST", "/auth/enroll", body)));
      assert.deepEqual(results.map((r) => r.status).sort(), [201, 401]);
      const enrolled = results.find((r) => r.status === 201)!;
      deviceToken = enrolled.data.access_token;
      deviceId = enrolled.data.device_id;
      assert.equal((await call("GET", "/auth/sessions", undefined, deviceToken)).status, 403);
      assert.equal(
        (await call("POST", "/client/enrollment-codes", { name: "denied" }, deviceToken)).status,
        403,
      );
      const revoked = await call("POST", "/client/enrollment-codes", { name: "revoked" }, token);
      assert.equal(
        (await call("DELETE", `/client/enrollment-codes/${revoked.data.id}`, undefined, token))
          .status,
        204,
      );
      assert.equal(
        (await call("POST", "/auth/enroll", { ...body, code: revoked.data.code })).status,
        401,
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
      "TOTP uses authenticated encryption, one-use factors and recovery codes",
      async () => {
        assert.equal(totpCode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1), "287082");
        const sealed = sealSecret("private", "mfa:a");
        assert.equal(openSecret(sealed, "mfa:a"), "private");
        assert.throws(() => openSecret(sealed, "mfa:b"));
        const setup = await call("POST", "/auth/mfa/setup", { password }, token);
        assert.equal(setup.status, 200, JSON.stringify(setup.data));
        const counter = Math.floor(Date.now() / 30_000);
        const confirm = await call(
          "POST",
          "/auth/mfa/confirm",
          { password, code: totpCode(setup.data.secret, counter) },
          token,
        );
        assert.equal(confirm.status, 200);
        assert.equal(confirm.data.recovery_codes.length, 8);
        const body = { username: "admin", password, client_type: "linux" };
        assert.equal((await call("POST", "/auth/login", body)).data.error_code, "MFA_REQUIRED");
        assert.equal(
          (
            await call("POST", "/auth/login", {
              ...body,
              mfa_code: totpCode(setup.data.secret, counter),
            })
          ).data.error_code,
          "MFA_INVALID",
        );
        const recovered = await call("POST", "/auth/login", {
          ...body,
          mfa_code: confirm.data.recovery_codes[0],
        });
        assert.equal(recovered.status, 200);
        assert.equal(
          (await call("POST", "/auth/login", { ...body, mfa_code: confirm.data.recovery_codes[0] }))
            .data.error_code,
          "MFA_INVALID",
        );
        const sessions = await call(
          "GET",
          "/auth/sessions",
          undefined,
          recovered.data.access_token,
        );
        assert.ok(sessions.data.items.some((s: { current: boolean }) => s.current));
        assert.equal(
          (
            await call(
              "POST",
              "/auth/mfa/disable",
              { password, mfa_code: confirm.data.recovery_codes[1] },
              recovered.data.access_token,
            )
          ).status,
          204,
        );
        assert.equal((await call("GET", "/auth/session", undefined, token)).status, 401);
        const rows = await db.query<{ after_value: unknown }>(
          "SELECT after_value FROM audit_events",
        );
        const audit = JSON.stringify(rows);
        assert.ok(!audit.includes(setup.data.secret));
        assert.ok(!audit.includes(confirm.data.recovery_codes[0]));
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
