import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { once } from "node:events";
import test from "node:test";

const sdp = [
  "v=0",
  "o=- 1 1 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 0.0.0.0",
  "a=mid:0",
  "a=ice-ufrag:abcd",
  "a=ice-pwd:abcdefghijklmnopqrstuv",
  "a=setup:actpass",
  `a=fingerprint:sha-256 ${Array(32).fill("AA").join(":")}`,
  "a=sctp-port:5000",
  "a=candidate:1 1 udp 2130706431 192.0.2.1 5000 typ host",
  "a=end-of-candidates",
  "",
].join("\r\n");

test("browser assistance binds account consent, direct SDP and both live sessions", async (t) => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    SQLITE_PATH: ":memory:",
    COOKIE_SECURE: "false",
    INTERNAL_SERVICE_KEY: "11".repeat(32),
    FRPS_PLUGIN_KEY: "22".repeat(32),
    LEASE_SIGNING_KEY: "33".repeat(32),
    BOOTSTRAP_ADMIN_PASSWORD: "Browser-Bootstrap-Password-safe",
    HOMEDESK_ID_SERVER: "signal.example.com:21116",
    HOMEDESK_HBBS_PUBLIC_KEY: Buffer.alloc(32, 7).toString("base64"),
    RD_STUN_URLS: "stun:signal.example.com:3478",
  });
  const db = await import("./db.js"),
    { hashPassword } = await import("./security.js");
  const { createApplication } = await import("./server.js");
  const { browserSdp, browserSdpDigest } = await import("./browser-remote.js");
  const { permitTrust } = await import("./remote-permit.js");
  const server = (await createApplication()).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`,
    password = "Browser-Normal-Password-safe";
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
    const account = (
      await call("POST", "/auth/login", undefined, { username, password, client_type: "windows" })
    ).data;
    const device = (
      await call("POST", "/auth/devices", account.access_token, {
        name: username + " computer",
        install_id: randomUUID(),
        fingerprint_hash: "ab".repeat(32),
        client_version: "13.0.0",
        client_type: "windows",
        credential_purpose: "gui",
      })
    ).data;
    const key = generateKeyPairSync("ed25519");
    const config = (await call("GET", "/homedesk/config", account.access_token)).data;
    assert.equal(
      (
        await call("PUT", "/homedesk/devices/current", device.access_token, {
          device_id: device.device_id,
          remote_id: remoteId,
          server: config.server,
          key_sha256: config.key_sha256,
          platform: "windows",
          remote_public_key: key.publicKey
            .export({ format: "der", type: "spki" })
            .subarray(-32)
            .toString("base64"),
          remote_proof: sign(
            null,
            Buffer.from(`NestLink-binding-v2:${permitTrust.realm}:${device.device_id}:${remoteId}`),
            key.privateKey,
          ).toString("base64"),
        })
      ).status,
      200,
    );
    device.session_id = (
      await call("GET", "/remote/presence", device.access_token)
    ).data.session_id;
    return { account, device, remoteId };
  }
  try {
    const hashed = await hashPassword(password);
    await db.query("UPDATE users SET password_hash=?,password_state='normal' WHERE role='admin'", [
      hashed,
    ]);
    for (const username of ["guest", "third"])
      await db.query(
        "INSERT INTO users(id,username,display_name,password_hash,password_state,role) VALUES(?,?,?,?,'normal','user')",
        [randomUUID(), username, username + " display", hashed],
      );
    const controller = await setup("admin", "123456789"),
      host = await setup("guest", "987654321"),
      third = await setup("third", "246813579");
    await t.test(
      "only an account may control; only an authenticated desktop may host",
      async () => {
        assert.equal((await call("GET", "/browser/config")).status, 401);
        assert.equal(
          (await call("POST", "/browser/hosts/poll", controller.account.access_token, {})).status,
          403,
        );
        assert.equal(
          (
            await call("POST", "/browser/sessions", controller.device.access_token, {
              target_id: host.remoteId,
              offer: sdp,
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await call("POST", "/browser/sessions", controller.account.access_token, {
              target_id: host.remoteId,
              offer: sdp,
            })
          ).data.error_code,
          "BROWSER_HOST_OFFLINE",
        );
        const configuration = await call("GET", "/browser/config", controller.account.access_token);
        assert.deepEqual(configuration.data.ice_servers, [
          { urls: ["stun:signal.example.com:3478"] },
        ]);
        assert.equal(configuration.data.policy, "require_direct");
        assert.equal(
          (await call("POST", "/browser/hosts/poll", host.device.access_token, {})).status,
          200,
        );
      },
    );
    await t.test(
      "SDP accepts UDP with DTLS; TCP, relay, audio/video and altered fingerprints are rejected",
      () => {
        assert.equal(browserSdp(sdp), sdp);
        for (const invalid of [
          sdp.replace("typ host", "typ relay"),
          sdp.replace("1 1 udp", "1 1 tcp"),
          sdp.replace("sha-256", "sha-1"),
          sdp + "m=video 9 UDP/TLS/RTP/SAVPF 96\r\n",
          "v=0\r\n",
          sdp.repeat(80),
        ]) {
          assert.throws(() => browserSdp(invalid));
        }
      },
    );
    const pending = await call("POST", "/browser/sessions", controller.account.access_token, {
      target_id: host.remoteId,
      offer: sdp,
      password: "disposable-remote-secret",
    });
    assert.equal(pending.status, 201, JSON.stringify(pending.data));
    const id = pending.data.session_id,
      route = `/browser/sessions/${id}`;
    await t.test(
      "cross-account approval discloses the requester but no other account directory",
      async () => {
        assert.equal(pending.data.state, "pending");
        assert.equal(pending.data.grant, "");
        const directory = await call("GET", "/homedesk/devices", controller.account.access_token);
        assert.deepEqual(
          directory.data.items.map((item: { remote_id: string }) => item.remote_id),
          [controller.remoteId],
        );
        const inbox = await call("POST", "/browser/hosts/poll", host.device.access_token, {});
        assert.equal(inbox.data.items[0].password, "disposable-remote-secret");
        assert.ok(inbox.data.items[0].controller_name.endsWith("(admin)"));
        assert.equal((await call("GET", route, third.account.access_token)).status, 404);
        assert.equal(
          (
            await call("POST", route + "/decision", controller.account.access_token, {
              approve: true,
              answer: sdp,
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await call("POST", route + "/decision", host.device.access_token, {
              approve: true,
              answer: sdp.replace("typ host", "typ relay"),
            })
          ).status,
          400,
        );
      },
    );
    const answer = sdp.replace("actpass", "active");
    const approved = await call("POST", route + "/decision", host.device.access_token, {
      approve: true,
      answer,
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.data));
    await t.test(
      "the 15-second Ed25519 grant authenticates both SDP descriptions and sessions",
      () => {
        const [prefix, payload, signature] = approved.data.grant.split(".");
        assert.equal(prefix, "nlb1");
        const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
        assert.equal(claims.jti, id);
        assert.equal(claims.host_device, host.device.device_id);
        assert.equal(claims.host_session, host.device.session_id);
        assert.equal(claims.controller_session, controller.account.session_id);
        assert.equal(claims.realm, permitTrust.realm);
        assert.equal(claims.exp - claims.iat, 15);
        assert.equal(claims.offer_sha256, browserSdpDigest(sdp));
        assert.equal(claims.answer_sha256, browserSdpDigest(answer));
        const der = Buffer.concat([
          Buffer.from("302a300506032b6570032100", "hex"),
          Buffer.from(permitTrust.public_key, "base64"),
        ]);
        assert.ok(
          verify(
            null,
            Buffer.from(`nlb1.${payload}`),
            { key: der, format: "der", type: "spki" },
            Buffer.from(signature, "base64url"),
          ),
        );
        assert.ok(
          !verify(
            null,
            Buffer.from(`nlb1.${payload}A`),
            { key: der, format: "der", type: "spki" },
            Buffer.from(signature, "base64url"),
          ),
        );
      },
    );
    await t.test(
      "approval cannot be replayed; deletion releases the host and erases SDP/secrets",
      async () => {
        assert.equal(
          (
            await call("POST", route + "/decision", host.device.access_token, {
              approve: true,
              answer,
            })
          ).status,
          409,
        );
        assert.equal(
          (await call("POST", "/browser/hosts/poll", host.device.access_token, {})).data.items
            .length,
          0,
        );
        assert.equal(
          (
            await call("POST", "/browser/sessions", controller.account.access_token, {
              target_id: host.remoteId,
              offer: sdp,
            })
          ).status,
          409,
        );
        assert.equal((await call("DELETE", route, controller.account.access_token)).status, 204);
        const closed = (await call("GET", route, host.device.access_token)).data;
        assert.equal(closed.state, "closed");
        assert.equal(closed.answer, "");
        assert.equal(closed.grant, "");
      },
    );
    await t.test(
      "host logout immediately ends a pending/active controller authorization",
      async () => {
        const next = await call("POST", "/browser/sessions", controller.account.access_token, {
          target_id: host.remoteId,
          offer: sdp,
        });
        assert.equal(next.status, 201);
        assert.equal(
          (await call("POST", "/auth/logout", host.account.access_token, {})).status,
          204,
        );
        const closed = await call(
          "POST",
          `/browser/sessions/${next.data.session_id}/heartbeat`,
          controller.account.access_token,
          {},
        );
        assert.equal(closed.data.state, "closed");
        assert.equal(closed.data.grant, "");
        assert.equal(
          (await call("POST", "/browser/hosts/poll", host.device.access_token, {})).status,
          401,
        );
      },
    );
    await t.test("guessing offline target IDs is rate limited", async () => {
      for (let i = 0; i < 5; i++)
        assert.equal(
          (
            await call("POST", "/browser/sessions", third.account.access_token, {
              target_id: "offline-id",
              offer: sdp,
            })
          ).status,
          404,
        );
      assert.equal(
        (
          await call("POST", "/browser/sessions", third.account.access_token, {
            target_id: "offline-id",
            offer: sdp,
          })
        ).status,
        429,
      );
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await db.closeDatabase();
  }
});
