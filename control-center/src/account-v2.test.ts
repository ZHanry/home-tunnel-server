import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";

test("v2 account and device authentication preserve independent background lifetimes", async (t) => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    SQLITE_PATH: ":memory:",
    COOKIE_SECURE: "false",
    INTERNAL_SERVICE_KEY: "11".repeat(32),
    FRPS_PLUGIN_KEY: "22".repeat(32),
    LEASE_SIGNING_KEY: "33".repeat(32),
    BOOTSTRAP_ADMIN_PASSWORD: "V2-Bootstrap-Password-safe",
  });
  const db = await import("./db.js");
  const { hashPassword } = await import("./security.js");
  const { createApplication } = await import("./server.js");
  const { attachRealtime } = await import("./realtime.js");
  const server = (await createApplication()).listen(0, "127.0.0.1");
  const realtime = attachRealtime(server);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const password = "V2-Normal-Password-safe";
  let requestNumber = 0;
  const sockets: WebSocket[] = [];
  async function call(method: string, path: string, body?: unknown, token?: string) {
    const response = await fetch(origin + path, {
      method,
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": `192.0.2.${++requestNumber}`,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      data: response.status === 204 ? null : await response.json(),
    };
  }
  const login = () =>
    call("POST", "/api/v2/auth/login", { username: "admin", password, client_type: "windows" });
  const deviceBody = (purpose: "gui" | "background") => ({
    name: purpose === "gui" ? "Home computer" : "Home NAS",
    install_id: "installation-stable",
    fingerprint_hash: "ab".repeat(32),
    client_version: "13.0.0",
    client_type: purpose === "gui" ? "windows" : "nas",
    credential_purpose: purpose,
  });
  try {
    await db.query("UPDATE users SET password_hash=?,password_state='normal' WHERE role='admin'", [
      await hashPassword(password),
    ]);
    const account = await login();
    assert.equal(account.status, 200);
    assert.ok(account.data.session_id);
    const token = account.data.access_token;
    const gui = await call("POST", "/api/v2/auth/devices", deviceBody("gui"), token);
    const background = await call("POST", "/api/v2/auth/devices", deviceBody("background"), token);
    assert.equal(gui.status, 201, JSON.stringify(gui.data));
    assert.equal(background.status, 201, JSON.stringify(background.data));
    assert.notEqual(gui.data.device_id, background.data.device_id);
    await t.test(
      "all registration and GUI credential entry points require an account",
      async () => {
        assert.equal((await call("POST", "/api/v2/auth/devices", deviceBody("gui"))).status, 401);
        assert.equal(
          (await call("POST", "/api/v2/auth/devices", deviceBody("gui"), gui.data.access_token))
            .status,
          403,
        );
        const credential = {
          device_id: gui.data.device_id,
          device_credential: gui.data.device_credential,
        };
        assert.equal(
          (await call("POST", "/api/v2/auth/device", credential)).data.error_code,
          "ACCOUNT_SESSION_REQUIRED",
        );
        assert.equal(
          (await call("POST", "/api/v1/auth/device", credential)).data.error_code,
          "ACCOUNT_SESSION_REQUIRED",
        );
        assert.equal(
          (await call("POST", "/api/v2/auth/device", { ...credential, management_token: token }))
            .status,
          200,
        );
        assert.equal(
          (await call("GET", "/api/v2/homedesk/devices", undefined, gui.data.access_token)).status,
          403,
        );
        assert.equal(
          (
            await call("POST", "/api/v2/auth/login", {
              username: "admin",
              password,
              mfa_code: "obsolete",
            })
          ).status,
          400,
        );
      },
    );
    await t.test(
      "account and GUI refresh rotate while preserving their parent relationship",
      async () => {
        const refreshed = await call("POST", "/api/v2/auth/refresh", {
          refresh_token: gui.data.refresh_token,
          client_type: "windows",
        });
        assert.equal(refreshed.status, 200);
        gui.data.access_token = refreshed.data.access_token;
        gui.data.refresh_token = refreshed.data.refresh_token;
        assert.equal(
          (await call("GET", "/api/v2/auth/me", undefined, gui.data.access_token)).status,
          200,
        );
      },
    );
    await t.test(
      "logout delivers immediate revocation to GUI sockets and keeps NAS running",
      async () => {
        const socket = new WebSocket(origin.replace("http", "ws") + "/api/v1/ws", {
          headers: { authorization: `Bearer ${gui.data.access_token}` },
        });
        sockets.push(socket);
        await once(socket, "open");
        const messages: string[] = [];
        socket.on("message", (message) => messages.push(message.toString()));
        const closed = once(socket, "close");
        assert.equal((await call("POST", "/api/v2/auth/logout", {}, token)).status, 204);
        const closeResult = await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            const timer = setTimeout(
              () => reject(new Error("GUI revocation was not delivered")),
              3000,
            );
            timer.unref();
          }),
        ]);
        assert.equal(closeResult[0], 4001);
        assert.ok(messages.some((message) => message.includes("account.session.revoked")));
        assert.equal(
          (await call("GET", "/api/v2/auth/me", undefined, gui.data.access_token)).status,
          401,
        );
        assert.equal(
          (
            await call("POST", "/api/v2/auth/refresh", {
              refresh_token: gui.data.refresh_token,
              client_type: "windows",
            })
          ).status,
          401,
        );
        assert.equal(
          (await call("GET", "/api/v1/client/connections", undefined, background.data.access_token))
            .status,
          200,
        );
        assert.equal(
          (
            await call("POST", "/api/v1/auth/device", {
              device_id: background.data.device_id,
              device_credential: background.data.device_credential,
            })
          ).status,
          200,
        );
      },
    );
    await t.test(
      "new account login retains GUI identity without altering background secrets",
      async () => {
        const next = await login();
        const guiAgain = await call(
          "POST",
          "/api/v2/auth/devices",
          deviceBody("gui"),
          next.data.access_token,
        );
        assert.equal(guiAgain.status, 201);
        assert.equal(guiAgain.data.device_id, gui.data.device_id);
        assert.notEqual(guiAgain.data.device_credential, gui.data.device_credential);
        assert.equal(
          (
            await call("POST", "/api/v2/auth/device", {
              device_id: gui.data.device_id,
              device_credential: gui.data.device_credential,
              management_token: next.data.access_token,
            })
          ).status,
          401,
        );
        const nasAgain = await call(
          "POST",
          "/api/v2/auth/devices",
          deviceBody("background"),
          next.data.access_token,
        );
        assert.equal(nasAgain.status, 409);
        assert.equal(
          (
            await call("POST", "/api/v1/auth/device", {
              device_id: background.data.device_id,
              device_credential: background.data.device_credential,
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await call(
              "DELETE",
              "/api/v2/auth/sessions/" + next.data.session_id,
              undefined,
              next.data.access_token,
            )
          ).status,
          204,
        );
        assert.equal(
          (await call("GET", "/api/v2/auth/me", undefined, guiAgain.data.access_token)).status,
          401,
        );
        const fresh = await login();
        const revoked = await call(
          "DELETE",
          "/api/v2/auth/devices/" + background.data.device_id,
          undefined,
          fresh.data.access_token,
        );
        assert.equal(revoked.status, 204, JSON.stringify(revoked.data));
        assert.equal(
          (
            await call("POST", "/api/v1/auth/device", {
              device_id: background.data.device_id,
              device_credential: background.data.device_credential,
            })
          ).status,
          401,
        );
      },
    );
  } finally {
    for (const socket of sockets) socket.terminate();
    await realtime.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await db.closeDatabase();
  }
});
