import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { validateApiResponse } from "./api-contract-test-helper.js";

const directory = mkdtempSync(join(tmpdir(), "ht-native-remote-"));
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
writeFileSync(
  join(directory, "rd-key.pem"),
  keys.privateKey.export({ type: "pkcs8", format: "pem" }),
  { mode: 0o600 },
);
Object.assign(process.env, {
  NODE_ENV: "test",
  BOOTSTRAP_ADMIN_PASSWORD: "Native-Bootstrap-Sample-2026!",
  SQLITE_PATH: ":memory:",
  COOKIE_SECURE: "false",
  INTERNAL_SERVICE_KEY: "11".repeat(32),
  FRPS_PLUGIN_KEY: "22".repeat(32),
  LEASE_SIGNING_KEY: "33".repeat(32),
  RD_ENABLED: "true",
  RD_SIGNING_KEY_FILE: join(directory, "rd-key.pem"),
  PUBLIC_BASE_URL: "https://console.example.test",
});
const [{ createApplication }, db, http, security, rd, crypto] = await Promise.all([
  import("./server.js"),
  import("./db.js"),
  import("./http.js"),
  import("./security.js"),
  import("./rd/service.js"),
  import("./rd/crypto.js"),
]);
const canonicalOrigin = "https://console.example.test";
const signature = (key: KeyObject, payload: unknown, typ = "ht-rd-proof+jwt") => {
  const body = `${Buffer.from(JSON.stringify({ alg: "ES256", typ })).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  return `${body}.${sign("sha256", Buffer.from(body), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
};

test("native remote handoff is single-use, origin/session bound and controller-only", async (t) => {
  const server = (await createApplication()).listen(0, "127.0.0.1");
  await once(server, "listening");
  const realtime = (await import("./realtime.js")).attachRealtime(server);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  let ip = 1;
  async function call(
    method: string,
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ) {
    const response = await fetch(base + "/api/v1" + path, {
      method,
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": `192.0.2.${ip++}`,
        origin: canonicalOrigin,
        "sec-fetch-site": "same-origin",
        ...extra,
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
      headers: response.headers,
    };
  }
  try {
    const user = (await db.one<{ id: string }>("SELECT id FROM users WHERE role='admin'"))!.id,
      device = randomUUID();
    await db.query("UPDATE users SET password_state='normal' WHERE id=?", [user]);
    await db.query(
      "INSERT INTO devices(id,user_id,name,install_id,fingerprint_hash,credential_hash) VALUES(?,?,?,?,?,?)",
      [
        device,
        user,
        "Native sample",
        randomUUID(),
        randomUUID(),
        security.tokenHash("sample-device-credential"),
      ],
    );
    const issue = (deviceId: string | null = device) =>
      db.transaction((client) =>
        http.issueSession(
          client,
          { id: user, token_version: 1 },
          deviceId,
          deviceId ? "device" : "web",
        ),
      );
    const mint = async (session: Awaited<ReturnType<typeof issue>>) =>
      call(
        "POST",
        "/auth/native-remote-handoff",
        { origin: canonicalOrigin },
        { authorization: `Bearer ${session.accessToken}` },
      );
    const redeem = (code: string, headers: Record<string, string> = {}) =>
      call("POST", "/auth/native-remote-handoff/redeem", { code }, headers);
    const native = async () => {
      const parent = await issue();
      const handoff = await mint(parent);
      assert.equal(handoff.status, 200);
      const opened = await redeem(handoff.data.code);
      assert.equal(opened.status, 200);
      return {
        parent,
        handoff,
        opened,
        headers: { cookie: opened.cookie, "x-csrf-token": opened.data.csrf_token },
      };
    };
    await t.test(
      "concurrent redemption has one winner; code is hashed and replay rejected",
      async () => {
        const parent = await issue(),
          handoff = await mint(parent);
        assert.equal(handoff.status, 200);
        assert.equal(handoff.data.window_id, parent.sessionId);
        assert.equal(handoff.headers.get("cache-control"), "no-store");
        const saved = await db.one(
          "SELECT * FROM native_remote_handoffs WHERE parent_session_id=?",
          [parent.sessionId],
        );
        assert.equal(saved?.code_hash, security.tokenHash(handoff.data.code));
        assert.ok(!JSON.stringify(saved).includes(handoff.data.code));
        const attempts = await Promise.all([redeem(handoff.data.code), redeem(handoff.data.code)]);
        assert.deepEqual(attempts.map((result) => result.status).sort(), [200, 401]);
        const accepted = attempts.find((result) => result.status === 200)!;
        assert.equal(accepted.data.access_token, undefined);
        assert.equal(accepted.data.refresh_token, undefined);
        assert.ok(
          accepted.headers
            .getSetCookie()
            .every((cookie) => cookie.includes("HttpOnly") && cookie.includes("SameSite=Strict")),
        );
        const probe = await call("GET", "/auth/session", undefined, { cookie: accepted.cookie });
        assert.equal(probe.data.native_window_id, parent.sessionId);
        assert.equal((await redeem(handoff.data.code)).status, 401);
        assert.equal(
          (await call("GET", "/auth/session", undefined, { cookie: accepted.cookie })).status,
          200,
        );
      },
    );
    await t.test("origins, expiry, source scope and logout fail closed", async () => {
      const parent = await issue(),
        handoff = await mint(parent);
      for (const origin of [
        "",
        "null",
        "https://attacker.test",
        `${canonicalOrigin}.attacker.test`,
        "http://console.example.test",
      ])
        assert.equal((await redeem(handoff.data.code, { origin })).status, 403);
      assert.equal(
        (await redeem(handoff.data.code, { "sec-fetch-site": "cross-site" })).status,
        403,
      );
      assert.equal((await mint(await issue(null))).status, 403);
      assert.equal(
        (
          await call(
            "POST",
            "/auth/native-remote-handoff",
            { origin: "https://attacker.test" },
            { authorization: `Bearer ${parent.accessToken}` },
          )
        ).status,
        403,
      );
      await db.query("UPDATE native_remote_handoffs SET expires_at=? WHERE parent_session_id=?", [
        new Date(Date.now() - 1000),
        parent.sessionId,
      ]);
      assert.equal((await redeem(handoff.data.code)).status, 401);
      const fresh = await mint(parent);
      await call(
        "POST",
        "/auth/session/close",
        {},
        { authorization: `Bearer ${parent.accessToken}` },
      );
      assert.equal((await redeem(fresh.data.code)).status, 401);
    });
    const connected = await native();
    await t.test(
      "native cookies never gain account/admin/device write or bearer-refresh authority",
      async () => {
        const me = await call("GET", "/auth/me", undefined, connected.headers);
        assert.equal(me.data.native_remote, true);
        assert.equal(me.data.device_id, device);
        assert.deepEqual(me.data.capabilities, ["remote:controller"]);
        for (const [method, path, body] of [
          ["GET", "/admin/users", undefined],
          ["GET", "/client/connections", undefined],
          ["POST", "/auth/native-remote-handoff", { origin: canonicalOrigin }],
          ["POST", "/rd/reauth", { password: "test-only" }],
          ["PATCH", "/devices/current/name", { name: "No" }],
        ] as const)
          assert.equal((await call(method, path, body, connected.headers)).status, 403, path);
        assert.equal(
          (await call("POST", "/auth/refresh", { client_type: "linux" }, connected.headers)).status,
          403,
        );
        const refreshed = await call(
          "POST",
          "/auth/refresh",
          { client_type: "web" },
          connected.headers,
        );
        assert.equal(refreshed.status, 200);
        assert.equal(refreshed.data.access_token, undefined);
        connected.headers.cookie = refreshed.cookie;
        assert.equal(
          (await call("GET", "/auth/session", undefined, connected.headers)).data.native_window_id,
          connected.parent.sessionId,
        );
      },
    );
    await t.test(
      "expired native access refreshes without changing source-window authority",
      async () => {
        const headers = { ...connected.headers, "x-native-window-id": connected.parent.sessionId };
        await db.query("UPDATE sessions SET access_expires_at=? WHERE native_parent_session_id=?", [
          new Date(Date.now() - 1000),
          connected.parent.sessionId,
        ]);
        assert.equal((await call("GET", "/auth/session", undefined, headers)).status, 401);
        const renewed = await call("POST", "/auth/refresh", { client_type: "web" }, headers);
        assert.equal(renewed.status, 200);
        connected.headers.cookie = renewed.cookie;
        assert.equal(
          (await call("GET", "/auth/session", undefined, { ...headers, cookie: renewed.cookie }))
            .data.native_window_id,
          connected.parent.sessionId,
        );
        const changed = { ...connected.headers, "x-native-window-id": randomUUID() };
        assert.equal((await call("GET", "/auth/me", undefined, changed)).status, 403);
        assert.equal(
          (await call("POST", "/auth/refresh", { client_type: "web" }, changed)).status,
          403,
        );
        const account = await issue(null);
        assert.equal(
          (
            await call("GET", "/auth/me", undefined, {
              authorization: `Bearer ${account.accessToken}`,
              "x-native-window-id": connected.parent.sessionId,
            })
          ).status,
          403,
        );
      },
    );
    await t.test(
      "native cookies and bearer values cannot open ordinary account realtime",
      async () => {
        const token = connected.headers.cookie
          .split("; ")
          .find((value) => value.startsWith("ht_access="))!
          .slice("ht_access=".length);
        for (const headers of [
          { cookie: connected.headers.cookie, origin: canonicalOrigin },
          { authorization: `Bearer ${token}` },
        ]) {
          const status = await new Promise<number>((resolve, reject) => {
            const socket = new WebSocket(base.replace("http:", "ws:") + "/api/v1/ws", { headers });
            socket.on("error", () => undefined);
            socket.once("open", () => {
              socket.terminate();
              reject(new Error("native scope escaped into ordinary realtime"));
            });
            socket.once("unexpected-response", (_request, response) => {
              response.resume();
              resolve(response.statusCode!);
            });
          });
          assert.equal(status, 401);
        }
      },
    );
    const controllerKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const publicJwk = crypto.publicJwk(controllerKey.publicKey.export({ format: "jwk" }));
    let endpointToken = "",
      endpointId = "",
      endpointNonce = "";
    await t.test(
      "controller enrollment binds source device and cannot enroll a host or another device",
      async () => {
        const body = { endpoint_kind: "browser", role: "controller", public_jwk: publicJwk };
        assert.equal(
          (
            await call("POST", "/rd/enrollment-challenges", body, {
              cookie: connected.headers.cookie,
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await call(
              "POST",
              "/rd/enrollment-challenges",
              { ...body, role: "host", endpoint_kind: "desktop", linked_device_id: device },
              connected.headers,
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await call(
              "POST",
              "/rd/enrollment-challenges",
              { ...body, linked_device_id: randomUUID() },
              connected.headers,
            )
          ).status,
          403,
        );
        const challenge = await call("POST", "/rd/enrollment-challenges", body, connected.headers);
        assert.equal(challenge.status, 201);
        assert.equal(challenge.data.proof_payload.linked_device_id, device);
        const enrollment = await call(
          "POST",
          "/rd/endpoints",
          {
            challenge_id: challenge.data.challenge_id,
            signed_proof: signature(controllerKey.privateKey, challenge.data.proof_payload),
            name: "Native controller",
            platform: "browser",
          },
          connected.headers,
        );
        assert.equal(enrollment.status, 201);
        endpointToken = enrollment.data.token;
        endpointId = enrollment.data.endpoint.id;
        endpointNonce = enrollment.data.dpop_nonce;
        assert.equal((await rd.tokenIdentity(endpointToken)).endpoint.linked_device_id, device);
        const challenge2 = await call(
          "POST",
          "/rd/token-challenges",
          { endpoint_id: endpointId, purpose: "controller_refresh" },
          connected.headers,
        );
        assert.equal(challenge2.status, 201);
        const renewed = await call(
          "POST",
          "/rd/tokens",
          {
            endpoint_id: endpointId,
            challenge_id: challenge2.data.challenge_id,
            proof: signature(controllerKey.privateKey, challenge2.data.proof_payload),
          },
          connected.headers,
        );
        assert.equal(renewed.status, 200);
      },
    );
    await t.test(
      "same-device pairing and sessions are rejected including cookie plus DPoP",
      async () => {
        const host = randomUUID(),
          hostKey = generateKeyPairSync("ec", { namedCurve: "P-256" }),
          jwk = crypto.publicJwk(hostKey.publicKey.export({ format: "jwk" }));
        await db.query(
          "INSERT INTO rd_endpoints(id,owner_user_id,linked_device_id,kind,role,name,platform,public_jwk,jkt,local_enabled,capability_json,created_at,updated_at) VALUES(?,?,?,'desktop','host','Same computer','windows',?,?,1,'{\"status\":\"ready\"}',home_tunnel_now(),home_tunnel_now())",
          [host, user, device, JSON.stringify(jwk), crypto.thumbprint(jwk)],
        );
        const pairingBody = {
          host_endpoint_id: host,
          session_request_id: randomUUID(),
          permissions: ["view"],
          mode: "one_session",
          nonce_controller: randomBytes(32).toString("base64url"),
        };
        const proof = signature(
          controllerKey.privateKey,
          {
            htu: canonicalOrigin + "/api/v1/rd/pairings",
            htm: "POST",
            iat: Math.floor(Date.now() / 1000),
            jti: randomUUID(),
            ath: crypto.digest(endpointToken),
            nonce: endpointNonce,
          },
          "dpop+jwt",
        );
        const result = await call("POST", "/rd/pairings", pairingBody, {
          ...connected.headers,
          authorization: `DPoP ${endpointToken}`,
          dpop: proof,
        });
        assert.equal(result.status, 409);
        assert.equal(result.data.error_code, "RD_SELF_CONNECTION");
        const identity = await rd.tokenIdentity(endpointToken),
          grant = randomUUID(),
          key = randomUUID();
        await db.query(
          "INSERT INTO rd_grants(id,owner_user_id,controller_owner_user_id,host_endpoint_id,controller_endpoint_id,host_jkt,controller_jkt,scope_json,mode,one_session_request_id,grant_version,host_signature,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'[\"view\"]','one_session',?,1,'test-only',home_tunnel_now(),home_tunnel_now())",
          [grant, user, user, host, endpointId, crypto.thumbprint(jwk), identity.endpoint.jkt, key],
        );
        await assert.rejects(
          rd.createSession(identity, key, {
            host_endpoint_id: host,
            grant_id: grant,
            permissions: ["view"],
            display_id: "0",
            protocol: { major: 1, minor: 0 },
          }),
          { errorCode: "RD_SELF_CONNECTION" },
        );
        const password = "Sample-Assistance-Pass",
          salt = "sample-salt";
        await db.query(
          "INSERT INTO rd_assist_invites(id,device_code,host_owner_user_id,host_endpoint_id,password_salt,password_hash,expires_at,created_at) VALUES(?,?,?,?,?,?,home_tunnel_add_seconds(home_tunnel_now(),300),home_tunnel_now())",
          [
            randomUUID(),
            "123456789",
            user,
            host,
            salt,
            await security.hashPassword(`${salt}:${password}`),
          ],
        );
        await assert.rejects(rd.redeemAssistInvite(identity, "123456789", password), {
          errorCode: "RD_SELF_CONNECTION",
        });
      },
    );
    await t.test(
      "closing the native parent revokes cookies, refresh and DPoP descendants",
      async () => {
        assert.equal(
          (
            await call(
              "POST",
              "/auth/session/close",
              {},
              { authorization: `Bearer ${connected.parent.accessToken}` },
            )
          ).status,
          204,
        );
        assert.equal((await call("GET", "/auth/me", undefined, connected.headers)).status, 401);
        assert.equal(
          (await call("POST", "/auth/refresh", { client_type: "web" }, connected.headers)).status,
          401,
        );
        await assert.rejects(rd.tokenIdentity(endpointToken), { errorCode: "RD_AUTH_REVOKED" });
        assert.ok(
          (
            await db.one("SELECT revoked_at FROM sessions WHERE native_parent_session_id=?", [
              connected.parent.sessionId,
            ])
          )?.revoked_at,
        );
      },
    );
    await t.test(
      "hard expiry, device revocation and account version change invalidate derived sessions",
      async () => {
        const expired = await native();
        await db.query(
          "UPDATE sessions SET refresh_expires_at=? WHERE native_parent_session_id=?",
          [new Date(Date.now() - 1000), expired.parent.sessionId],
        );
        assert.equal((await call("GET", "/auth/me", undefined, expired.headers)).status, 401);
        const revoked = await native();
        await db.query("UPDATE devices SET status='revoked' WHERE id=?", [device]);
        assert.equal((await call("GET", "/auth/me", undefined, revoked.headers)).status, 401);
        assert.equal(
          (await call("POST", "/auth/refresh", { client_type: "web" }, revoked.headers)).status,
          401,
        );
        await db.query("UPDATE devices SET status='active' WHERE id=?", [device]);
        const changed = await native();
        await db.query("UPDATE users SET token_version=token_version+1 WHERE id=?", [user]);
        assert.equal((await call("GET", "/auth/me", undefined, changed.headers)).status, 401);
      },
    );
  } finally {
    await realtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.closeDatabase();
    rmSync(directory, { recursive: true, force: true });
  }
});
