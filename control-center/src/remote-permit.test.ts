import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import test from "node:test";

test("native permits isolate directories, allow authenticated cross-account assistance and expire on revocation", async (t) => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    SQLITE_PATH: ":memory:",
    COOKIE_SECURE: "false",
    INTERNAL_SERVICE_KEY: "11".repeat(32),
    FRPS_PLUGIN_KEY: "22".repeat(32),
    LEASE_SIGNING_KEY: "33".repeat(32),
    BOOTSTRAP_ADMIN_PASSWORD: "Permit-Bootstrap-Password-safe",
    HOMEDESK_ID_SERVER: "signal.example.com:21116",
    HOMEDESK_HBBS_PUBLIC_KEY: Buffer.alloc(32, 7).toString("base64"),
  });
  const db = await import("./db.js");
  const { hashPassword } = await import("./security.js");
  const { createApplication } = await import("./server.js");
  const { permitTrust, verifyPermit, signPermit } = await import("./remote-permit.js");
  const server = (await createApplication()).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const password = "Permit-Normal-Password-safe";
  async function call(method: string, path: string, token?: string, body?: unknown) {
    const response = await fetch(origin + "/api/v2" + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      data: response.status === 204 ? null : await response.json(),
    };
  }
  async function setup(username: string, remoteId: string) {
    const account = await call("POST", "/auth/login", undefined, {
      username,
      password,
      client_type: "windows",
    });
    assert.equal(account.status, 200);
    const device = await call("POST", "/auth/devices", account.data.access_token, {
      name: username + " computer",
      install_id: randomUUID(),
      fingerprint_hash: username === "admin" ? "ab".repeat(32) : "cd".repeat(32),
      client_version: "12.0.0-RC1",
      client_type: "windows",
      credential_purpose: "gui",
    });
    assert.equal(device.status, 201);
    const key = generateKeyPairSync("ed25519");
    const rawKey = key.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("base64");
    const config = (await call("GET", "/homedesk/config", account.data.access_token)).data;
    const body = {
      device_id: device.data.device_id,
      remote_id: remoteId,
      server: config.server,
      key_sha256: config.key_sha256,
      platform: "windows",
      remote_public_key: rawKey,
      remote_proof: sign(
        null,
        Buffer.from(
          `NestLink-binding-v2:${permitTrust.realm}:${device.data.device_id}:${remoteId}`,
        ),
        key.privateKey,
      ).toString("base64"),
    };
    assert.equal(
      (
        await call("PUT", "/homedesk/devices/current", device.data.access_token, {
          ...body,
          remote_proof: Buffer.alloc(64).toString("base64"),
        })
      ).status,
      403,
    );
    assert.equal(
      (await call("PUT", "/homedesk/devices/current", device.data.access_token, body)).status,
      200,
    );
    return { account: account.data, device: device.data, key, body };
  }
  try {
    const passwordHash = await hashPassword(password);
    await db.query("UPDATE users SET password_hash=?,password_state='normal' WHERE role='admin'", [
      passwordHash,
    ]);
    await db.query(
      "INSERT INTO users(id,username,display_name,password_hash,password_state,role) VALUES(?,'guest','Guest',?,'normal','user')",
      [randomUUID(), passwordHash],
    );
    const controller = await setup("admin", "123456789");
    const host = await setup("guest", "987654321");
    await t.test(
      "directory data stays account scoped while ID assistance has minimal output",
      async () => {
        const own = await call("GET", "/homedesk/devices", controller.account.access_token);
        assert.deepEqual(
          own.data.items.map((item: { remote_id: string }) => item.remote_id),
          ["123456789"],
        );
        assert.equal(
          (
            await call("POST", "/remote/permits", controller.account.access_token, {
              target_id: host.body.remote_id,
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await call("POST", "/remote/permits", controller.device.access_token, {
              target_id: "192.0.2.1",
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await call("POST", "/remote/permits", controller.device.access_token, {
              target_id: "not-online",
            })
          ).status,
          404,
        );
      },
    );
    const issued = await call("POST", "/remote/permits", controller.device.access_token, {
      target_id: host.body.remote_id,
    });
    assert.equal(issued.status, 201, JSON.stringify(issued.data));
    const id = issued.data.permit_id;
    const claims = verifyPermit(issued.data.permit);
    await t.test(
      "the signed permit binds both identities, keys, deployment and a short lifetime",
      () => {
        assert.equal(claims.controller_device, controller.device.device_id);
        assert.equal(claims.host_device, host.device.device_id);
        assert.equal(claims.controller_key, controller.body.remote_public_key);
        assert.equal(claims.policy, "require_direct");
        assert.equal(claims.exp - claims.iat, 45);
        const tampered = issued.data.permit.replace("nlp2.", "nlp2.A");
        assert.throws(() => verifyPermit(tampered));
        assert.throws(() => verifyPermit(issued.data.permit, claims.exp));
        assert.throws(() => verifyPermit(signPermit({ ...claims, realm: "00".repeat(32) })));
      },
    );
    await t.test(
      "only the chosen host can accept, and a permit cannot be replayed into another connection",
      async () => {
        assert.equal(
          (
            await call("POST", `/remote/permits/${id}/accept`, controller.device.access_token, {
              connection_id: "123",
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await call("POST", `/remote/permits/${id}/accept`, host.device.access_token, {
              connection_id: "123",
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await call("POST", `/remote/permits/${id}/accept`, host.device.access_token, {
              connection_id: "456",
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await call(
              "POST",
              `/remote/permits/${id}/heartbeat`,
              controller.device.access_token,
              {},
            )
          ).data.active,
          true,
        );
        assert.equal(
          (await call("POST", `/remote/permits/${id}/heartbeat`, host.device.access_token, {})).data
            .active,
          true,
        );
        await db.query("UPDATE native_remote_permits SET host_seen_at=? WHERE id=?", [
          new Date(Date.now() - 21_000),
          id,
        ]);
        assert.equal(
          (
            await call(
              "POST",
              `/remote/permits/${id}/heartbeat`,
              controller.device.access_token,
              {},
            )
          ).data.error_code,
          "REMOTE_PEER_EXPIRED",
        );
      },
    );
    await t.test("host logout revokes controller authority immediately", async () => {
      assert.equal((await call("POST", "/auth/logout", host.account.access_token, {})).status, 204);
      assert.equal(
        (await call("POST", `/remote/permits/${id}/heartbeat`, controller.device.access_token, {}))
          .status,
        403,
      );
      assert.equal(
        (
          await call("POST", "/remote/permits", controller.device.access_token, {
            target_id: host.body.remote_id,
          })
        ).status,
        404,
      );
      assert.equal((await call("GET", "/auth/me", host.device.access_token)).status, 401);
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await db.closeDatabase();
  }
});
