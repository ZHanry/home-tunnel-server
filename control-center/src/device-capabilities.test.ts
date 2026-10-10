import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";

const spec = JSON.parse(
  readFileSync(new URL("../../contracts/openapi.v2.json", import.meta.url), "utf8"),
);
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema({ $id: "capability-api-v2", components: spec.components });

test("one physical device retains distinct remote and tunnel authorization subjects", async (t) => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    SQLITE_PATH: ":memory:",
    COOKIE_SECURE: "false",
    INTERNAL_SERVICE_KEY: "11".repeat(32),
    FRPS_PLUGIN_KEY: "22".repeat(32),
    LEASE_SIGNING_KEY: "33".repeat(32),
    BOOTSTRAP_ADMIN_PASSWORD: "Capabilities-Bootstrap-safe-Q8",
  });
  const db = await import("./db.js");
  const { issueSession } = await import("./http.js");
  const { tokenHash } = await import("./security.js");
  const { createApplication } = await import("./server.js");
  await db.migrate();
  const ownerId = randomUUID(),
    foreignId = randomUUID(),
    adminId = randomUUID();
  for (const [id, name] of [
    [ownerId, "capability-owner"],
    [foreignId, "capability-other"],
    [adminId, "capability-admin"],
  ]) {
    await db.query(
      "INSERT INTO users(id,username,display_name,password_hash,password_state,role) VALUES(?,?,?,'fixture-hash','normal','user')",
      [id, name, name],
    );
    if (id === adminId) await db.query("UPDATE users SET role='admin' WHERE id=?", [id]);
  }
  async function subject(purpose: "gui" | "background", owner = ownerId) {
    const id = randomUUID();
    await db.query(
      `INSERT INTO devices(id,user_id,name,install_id,fingerprint_hash,credential_hash,credential_purpose,lease_expires_at)
        VALUES(?,?,'Identical name',?,?,?,?,?)`,
      [
        id,
        owner,
        randomUUID(),
        tokenHash(randomUUID()),
        tokenHash(randomUUID()),
        purpose,
        "2099-01-01",
      ],
    );
    return id;
  }
  async function pair(owner = ownerId) {
    return {
      remote_device_id: await subject("gui", owner),
      tunnel_device_id: await subject("background", owner),
    };
  }
  const first = await pair(),
    second = await pair(),
    third = await pair(),
    foreign = await pair(foreignId);
  const unlinked = await subject("background");
  const account = await db.transaction((client) =>
    issueSession(client, { id: ownerId, token_version: 1 }, null, "windows"),
  );
  const adminAccount = await db.transaction((client) =>
    issueSession(client, { id: adminId, token_version: 1 }, null, "web"),
  );
  const foreignAccount = await db.transaction((client) =>
    issueSession(client, { id: foreignId, token_version: 1 }, null, "windows"),
  );
  const remoteSession = await db.transaction(async (client) => {
    const session = await issueSession(
      client,
      { id: ownerId, token_version: 1 },
      first.remote_device_id,
      "device",
    );
    await client.query("UPDATE sessions SET management_parent_session_id=? WHERE id=?", [
      account.sessionId,
      session.sessionId,
    ]);
    return session;
  });
  const tunnelSession = await db.transaction((client) =>
    issueSession(client, { id: ownerId, token_version: 1 }, first.tunnel_device_id, "device"),
  );
  const connectionId = randomUUID();
  await db.query(
    `INSERT INTO connections(id,user_id,device_id,name,subdomain,local_scheme,local_host,local_port)
      VALUES(?,?,?,'Keep service','capability-service','http','127.0.0.1',8080)`,
    [connectionId, ownerId, first.tunnel_device_id],
  );
  const originalSubjects = await db.query(
    "SELECT id,credential_hash,install_id,fingerprint_hash,config_version,lease_expires_at FROM devices WHERE id IN (?,?) ORDER BY id",
    [first.remote_device_id, first.tunnel_device_id],
  );
  const server = (await createApplication(false)).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  async function call(
    method: string,
    path: string,
    body?: unknown,
    token?: string,
    cookie = false,
    csrf?: string,
  ) {
    const response = await fetch(origin + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token
          ? cookie
            ? { cookie: `ht_access=${token}` }
            : { authorization: `Bearer ${token}` }
          : {}),
        ...(csrf ? { "x-csrf-token": csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = response.status === 204 ? null : await response.json();
    const contractPath =
      path.startsWith("/api/v2/auth/device-capabilities/") && !path.endsWith("/link")
        ? "/api/v2/auth/device-capabilities/{remoteId}"
        : path.startsWith("/api/v2/auth/devices/")
          ? "/api/v2/auth/devices/{id}"
          : path;
    const contract =
      spec.paths[contractPath]?.[method.toLowerCase()]?.responses[String(response.status)];
    assert.ok(contract, `Undocumented response ${method} ${contractPath}: ${response.status}`);
    const schema = contract.content?.["application/json"]?.schema;
    if (schema) {
      const validate = ajv.compile(
        JSON.parse(
          JSON.stringify(schema).replaceAll('"#/components/', '"capability-api-v2#/components/'),
        ),
      );
      assert.ok(validate(data), JSON.stringify(validate.errors));
    }
    return { status: response.status, data };
  }
  const link = (body: unknown, token = account.accessToken) =>
    call("POST", "/api/v2/auth/device-capabilities/link", body, token);
  const directory = (token = account.accessToken) =>
    call("GET", "/api/v2/auth/device-capabilities", undefined, token);
  try {
    await t.test("requires a live account management session and cookie CSRF", async () => {
      assert.equal(
        (await call("POST", "/api/v2/auth/device-capabilities/link", first)).status,
        401,
      );
      for (const token of [remoteSession.accessToken, tunnelSession.accessToken]) {
        assert.equal((await link(first, token)).status, 403);
        assert.equal((await directory(token)).status, 403);
        assert.equal(
          (
            await call(
              "DELETE",
              `/api/v2/auth/device-capabilities/${first.remote_device_id}`,
              undefined,
              token,
            )
          ).status,
          403,
        );
      }
      assert.equal(
        (
          await call(
            "POST",
            "/api/v2/auth/device-capabilities/link",
            first,
            account.accessToken,
            true,
          )
        ).status,
        403,
      );
      const created = await call(
        "POST",
        "/api/v2/auth/device-capabilities/link",
        first,
        account.accessToken,
        true,
        account.csrfToken,
      );
      assert.equal(created.status, 201);
      assert.deepEqual(created.data, { physical_device_id: first.remote_device_id, ...first });
    });
    await t.test("validates ownership, active subjects and each capability purpose", async () => {
      for (const body of [
        {},
        { ...first, user_id: foreignId },
        { ...first, remote_device_id: "invalid" },
      ])
        assert.equal((await link(body)).status, 400);
      for (const body of [
        foreign,
        { ...first, tunnel_device_id: foreign.tunnel_device_id },
        { remote_device_id: first.tunnel_device_id, tunnel_device_id: first.remote_device_id },
        { remote_device_id: first.remote_device_id, tunnel_device_id: first.remote_device_id },
      ])
        assert.equal((await link(body)).status, 404);
      const inactive = await pair();
      await db.query(
        "UPDATE devices SET status='revoked',revoked_at=home_tunnel_now() WHERE id=?",
        [inactive.tunnel_device_id],
      );
      assert.equal((await link(inactive)).status, 404);
      assert.equal((await directory(foreignAccount.accessToken)).data.items.length, 0);
    });
    await t.test(
      "an exact pair is idempotent, leaves secrets and services intact and exposes only IDs",
      async () => {
        assert.equal((await link(first)).status, 200);
        assert.deepEqual((await directory()).data, {
          version: 1,
          items: [{ physical_device_id: first.remote_device_id, ...first }],
        });
        assert.deepEqual(
          await db.query(
            "SELECT id,credential_hash,install_id,fingerprint_hash,config_version,lease_expires_at FROM devices WHERE id IN (?,?) ORDER BY id",
            [first.remote_device_id, first.tunnel_device_id],
          ),
          originalSubjects,
        );
        assert.equal(
          (await db.one("SELECT device_id FROM connections WHERE id=?", [connectionId]))?.device_id,
          first.tunnel_device_id,
        );
        assert.equal(
          (await db.one("SELECT count(*) AS count FROM device_capability_links"))?.count,
          1,
        );
        assert.equal(
          (await db.one("SELECT revoked_at FROM sessions WHERE id=?", [remoteSession.sessionId]))
            ?.revoked_at,
          null,
        );
        assert.equal(
          (await db.one("SELECT revoked_at FROM sessions WHERE id=?", [tunnelSession.sessionId]))
            ?.revoked_at,
          null,
        );
        const subjects = await call(
          "GET",
          "/api/v1/client/devices",
          undefined,
          account.accessToken,
        );
        assert.equal(subjects.status, 200);
        for (const [id, purpose] of [
          [first.remote_device_id, "gui"],
          [first.tunnel_device_id, "background"],
          [second.remote_device_id, "gui"],
          [unlinked, "background"],
        ]) {
          assert.equal(
            subjects.data.items.find((item: { id: string }) => item.id === id)?.credential_purpose,
            purpose,
          );
        }
        await db.query(
          "INSERT INTO homedesk_bindings(device_id,remote_id,server,key_sha256,platform,last_seen) VALUES(?,'123456789','fixture.example.com',?,'android',home_tunnel_now())",
          [first.remote_device_id, "ab".repeat(32)],
        );
        for (const [path, token] of [
          ["/api/v1/client/devices", account.accessToken],
          ["/api/v1/admin/devices", adminAccount.accessToken],
        ] as const) {
          const catalog = await call("GET", path, undefined, token);
          const mobile = catalog.data.items.find(
            (item: { id: string }) => item.id === first.remote_device_id,
          );
          assert.equal(
            mobile.client_type,
            "android",
            "binding platform overrides generic device session",
          );
        }
      },
    );
    await t.test(
      "administrative associations are read-only, guarded and optionally scoped to one owner",
      async () => {
        assert.equal((await link(foreign, foreignAccount.accessToken)).status, 201);
        const path = "/api/v2/admin/device-capabilities";
        assert.equal((await call("GET", path)).status, 401);
        assert.equal((await call("GET", path, undefined, account.accessToken)).status, 403);
        assert.equal((await call("GET", path, undefined, remoteSession.accessToken)).status, 403);
        const all = await call("GET", path, undefined, adminAccount.accessToken);
        assert.equal(all.status, 200);
        assert.ok(all.data.items.some((item: { user_id: string }) => item.user_id === ownerId));
        assert.ok(all.data.items.some((item: { user_id: string }) => item.user_id === foreignId));
        const filteredResponse = await fetch(origin + path + "?user_id=" + foreignId, {
          headers: { authorization: "Bearer " + adminAccount.accessToken },
        });
        assert.equal(filteredResponse.status, 200);
        assert.equal(filteredResponse.headers.get("cache-control"), "no-store");
        const filtered = await filteredResponse.json();
        assert.deepEqual(filtered.items, [
          { user_id: foreignId, physical_device_id: foreign.remote_device_id, ...foreign },
        ]);
        const malformed = await fetch(origin + path + "?user_id=not-a-uuid", {
          headers: { authorization: "Bearer " + adminAccount.accessToken },
        });
        assert.equal(malformed.status, 400);
        assert.deepEqual((await directory()).data.items, [
          { physical_device_id: first.remote_device_id, ...first },
        ]);
        await db.query("UPDATE users SET password_state='must_change' WHERE id=?", [adminId]);
        assert.equal((await call("GET", path, undefined, adminAccount.accessToken)).status, 423);
        await db.query("UPDATE users SET password_state='normal' WHERE id=?", [adminId]);
        await db.query("UPDATE sessions SET revoked_at=home_tunnel_now() WHERE id=?", [
          adminAccount.sessionId,
        ]);
        assert.equal((await call("GET", path, undefined, adminAccount.accessToken)).status, 401);
        await db.query("DELETE FROM device_capability_links WHERE user_id=?", [foreignId]);
      },
    );
    await t.test("one-to-one conflicts cannot replace either existing association", async () => {
      assert.equal(
        (await link({ ...first, tunnel_device_id: second.tunnel_device_id })).status,
        409,
      );
      assert.equal(
        (await link({ ...second, tunnel_device_id: first.tunnel_device_id })).status,
        409,
      );
      assert.equal((await link(second)).status, 201);
      assert.equal((await link(foreign, foreignAccount.accessToken)).status, 201);
      assert.equal((await directory()).data.items.length, 2);
      assert.deepEqual((await directory(foreignAccount.accessToken)).data.items, [
        { physical_device_id: foreign.remote_device_id, ...foreign },
      ]);
      assert.equal(
        (
          await call(
            "DELETE",
            `/api/v2/auth/device-capabilities/${foreign.remote_device_id}`,
            undefined,
            account.accessToken,
          )
        ).status,
        404,
      );
    });
    await t.test(
      "a unilateral administrator revocation preserves canonical identity and omits revoked capabilities",
      async () => {
        await db.query(
          "UPDATE devices SET status='revoked',revoked_at=home_tunnel_now() WHERE id=?",
          [second.remote_device_id],
        );
        const remaining = (await directory()).data.items.find(
          (item: { physical_device_id: string }) =>
            item.physical_device_id === second.remote_device_id,
        );
        assert.deepEqual(remaining, {
          physical_device_id: second.remote_device_id,
          remote_device_id: null,
          tunnel_device_id: second.tunnel_device_id,
        });
        assert.equal((await link(second)).status, 404);
        await db.query(
          "UPDATE devices SET status='revoked',revoked_at=home_tunnel_now() WHERE id=?",
          [second.tunnel_device_id],
        );
        assert.equal((await directory()).data.items.length, 1);
      },
    );
    await t.test(
      "legacy removal of a linked capability revokes the whole device atomically",
      async () => {
        assert.equal(
          (
            await call(
              "DELETE",
              `/api/v2/auth/devices/${first.tunnel_device_id}`,
              undefined,
              account.accessToken,
            )
          ).status,
          204,
        );
        for (const id of [first.remote_device_id, first.tunnel_device_id]) {
          const device = await db.one(
            "SELECT status,revoked_at,lease_expires_at FROM devices WHERE id=?",
            [id],
          );
          assert.equal(device?.status, "revoked");
          assert.ok(device?.revoked_at);
          assert.ok(new Date(String(device?.lease_expires_at)).getTime() <= Date.now());
          assert.ok(
            (await db.one("SELECT revoked_at FROM sessions WHERE device_id=?", [id]))?.revoked_at,
          );
          assert.equal(
            (
              await db.one(
                "SELECT count(*) AS count FROM outbox_events WHERE event_type='subject.revoked' AND recipient_device_id=?",
                [id],
              )
            )?.count,
            1,
          );
        }
        assert.equal((await directory()).data.items.length, 0);
        assert.equal(
          (await db.one("SELECT deleted_at FROM connections WHERE id=?", [connectionId]))
            ?.deleted_at,
          null,
        );
        assert.equal(
          (await db.one("SELECT status FROM devices WHERE id=?", [unlinked]))?.status,
          "active",
        );
        assert.equal(
          (await call("DELETE", `/api/v2/auth/devices/${unlinked}`, undefined, account.accessToken))
            .status,
          204,
        );
      },
    );
    await t.test(
      "physical removal rolls back both subjects when the second update fails",
      async () => {
        assert.equal((await link(third)).status, 201);
        await db.query(`CREATE TRIGGER capability_test_fail BEFORE UPDATE ON devices
        WHEN OLD.id='${third.tunnel_device_id}' AND NEW.status='revoked'
        BEGIN SELECT RAISE(ABORT,'synthetic second capability failure'); END`);
        assert.equal(
          (
            await call(
              "DELETE",
              `/api/v2/auth/device-capabilities/${third.remote_device_id}`,
              undefined,
              account.accessToken,
            )
          ).status,
          500,
        );
        for (const id of [third.remote_device_id, third.tunnel_device_id]) {
          assert.equal(
            (await db.one("SELECT status FROM devices WHERE id=?", [id]))?.status,
            "active",
          );
          assert.equal(
            (
              await db.one(
                "SELECT count(*) AS count FROM outbox_events WHERE event_type='subject.revoked' AND recipient_device_id=?",
                [id],
              )
            )?.count,
            0,
          );
        }
        await db.query("DROP TRIGGER capability_test_fail");
        assert.equal(
          (
            await call(
              "DELETE",
              `/api/v2/auth/device-capabilities/${third.remote_device_id}`,
              undefined,
              account.accessToken,
            )
          ).status,
          204,
        );
        assert.equal((await directory()).data.items.length, 0);
      },
    );
    await t.test(
      "account logout and password requirements also protect capability operations",
      async () => {
        await db.query("UPDATE users SET password_state='must_change' WHERE id=?", [ownerId]);
        assert.equal((await directory()).status, 423);
        assert.equal((await link(first)).status, 423);
        await db.query("UPDATE users SET password_state='normal' WHERE id=?", [ownerId]);
        await db.query("UPDATE sessions SET revoked_at=home_tunnel_now() WHERE id=?", [
          account.sessionId,
        ]);
        assert.equal((await directory()).status, 401);
        assert.equal((await link(first)).status, 401);
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
