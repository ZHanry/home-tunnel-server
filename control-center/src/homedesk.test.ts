import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { validateApiResponse } from "./api-contract-test-helper.js";

test("HomeDesk directory enforces deployment, account and device boundaries", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "homedesk-directory-"));
  const path = join(directory, "db.sqlite");
  const key = Buffer.alloc(32, 7).toString("base64");
  const fingerprint = createHash("sha256").update(key).digest("hex");
  Object.assign(process.env, {
    NODE_ENV: "test",
    SQLITE_PATH: path,
    INTERNAL_SERVICE_KEY: "11".repeat(32),
    FRPS_PLUGIN_KEY: "22".repeat(32),
    LEASE_SIGNING_KEY: "33".repeat(32),
    COOKIE_SECURE: "false",
    HOMEDESK_ID_SERVER: "REMOTE.example.com",
    HOMEDESK_HBBS_PUBLIC_KEY: key,
  });
  const db = await import("./db.js");
  const { tokenHash } = await import("./security.js");
  const { createApplication } = await import("./server.js");
  await db.migrate();
  const owner = randomUUID(),
    other = randomUUID(),
    device = randomUUID(),
    sibling = randomUUID(),
    foreign = randomUUID();
  for (const id of [owner, other])
    await db.query(
      "INSERT INTO users(id,username,display_name,password_hash,password_state,role) VALUES(?,?,?,'fixture','normal','user')",
      [id, id, id],
    );
  for (const [id, user] of [
    [device, owner],
    [sibling, owner],
    [foreign, other],
  ])
    await db.query(
      "INSERT INTO devices(id,user_id,name,install_id,fingerprint_hash,credential_hash) VALUES(?,?,?,?,?,?)",
      [id, user, id, randomUUID(), randomUUID(), tokenHash(randomUUID())],
    );
  async function session(user: string, deviceId: string | null) {
    const access = randomUUID(),
      csrf = randomUUID();
    await db.query(
      `INSERT INTO sessions(id,user_id,device_id,token_family,token_version,access_token_hash,
      refresh_token_hash,csrf_token_hash,access_expires_at,refresh_expires_at) VALUES(?,?,?,?,1,?,?,?,?,?)`,
      [
        randomUUID(),
        user,
        deviceId,
        randomUUID(),
        tokenHash(access),
        tokenHash(randomUUID()),
        tokenHash(csrf),
        new Date(Date.now() + 3600_000),
        new Date(Date.now() + 7200_000),
      ],
    );
    return { access, csrf };
  }
  const account = await session(owner, null),
    bound = await session(owner, device);
  const siblingSession = await session(owner, sibling),
    foreignSession = await session(other, foreign);
  const foreignAccount = await session(other, null);
  const server = (await createApplication(false)).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const body = {
    device_id: device,
    remote_id: "123456789",
    server: "remote.example.com:21116",
    key_sha256: fingerprint,
    platform: "windows",
  };
  async function call(
    method: string,
    resource: string,
    access?: string,
    payload?: unknown,
    cookie = false,
    csrf?: string,
  ) {
    const response = await fetch(`${base}/api/v1/homedesk/${resource}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(access
          ? cookie
            ? { cookie: `ht_access=${access}` }
            : { authorization: `Bearer ${access}` }
          : {}),
        ...(csrf ? { "x-csrf-token": csrf } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    const data = await response.json();
    validateApiResponse(method, `/api/v1/homedesk/${resource}`, response.status, data);
    return { status: response.status, data };
  }
  try {
    await t.test("requires correct scope and CSRF", async () => {
      assert.equal((await call("GET", "devices")).status, 401);
      assert.equal((await call("GET", "devices", bound.access)).status, 403);
      assert.equal((await call("PUT", "devices/current", account.access, body)).status, 403);
      assert.equal((await call("PUT", "devices/current", bound.access, body, true)).status, 403);
      assert.equal(
        (await call("PUT", "devices/current", bound.access, body, true, bound.csrf)).status,
        200,
      );
    });
    await t.test(
      "trust identity uses trimmed Base64 text and cannot be supplied by another device",
      async () => {
        const discovery = await call("GET", "config", account.access);
        assert.equal(discovery.data.key_sha256, fingerprint);
        assert.equal(discovery.data.policy, "require_direct");
        assert.equal(discovery.data.relay_enabled, false);
        assert.equal(
          (await call("PUT", "devices/current", bound.access, { ...body, device_id: sibling }))
            .status,
          403,
        );
        assert.equal(
          (
            await call("PUT", "devices/current", bound.access, {
              ...body,
              server: "evil.example.com",
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await call("PUT", "devices/current", bound.access, {
              ...body,
              key_sha256: "00".repeat(32),
            })
          ).status,
          400,
        );
        for (const value of [
          { ...body, remote_id: "../../" },
          { ...body, platform: "unknown" },
          { ...body, owner_id: other },
        ])
          assert.equal((await call("PUT", "devices/current", bound.access, value)).status, 400);
      },
    );
    await t.test("global remote-ID uniqueness and account filtering", async () => {
      assert.equal(
        (
          await call("PUT", "devices/current", siblingSession.access, {
            ...body,
            device_id: sibling,
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await call("PUT", "devices/current", foreignSession.access, {
            ...body,
            device_id: foreign,
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await call("PUT", "devices/current", foreignSession.access, {
            ...body,
            device_id: foreign,
            remote_id: "987654321",
          })
        ).status,
        200,
      );
      const list = await call("GET", "devices", account.access);
      assert.equal(list.data.items.length, 1);
      assert.equal(list.data.items[0].device_id, device);
      assert.equal(list.data.items[0].online, true);
      assert.equal(list.data.items[0].user_id, undefined);
      assert.equal(
        (await call("GET", "devices", foreignAccount.access)).data.items[0].device_id,
        foreign,
      );
      await db.query("UPDATE homedesk_bindings SET last_seen=? WHERE device_id=?", [
        new Date(Date.now() - 120_000),
        device,
      ]);
      assert.equal((await call("GET", "devices", account.access)).data.items[0].online, false);
    });
    await t.test("device revocation removes its directory binding immediately", async () => {
      await db.query(
        "UPDATE devices SET status='revoked',revoked_at=home_tunnel_now() WHERE id=?",
        [device],
      );
      assert.equal((await call("GET", "devices", account.access)).data.items.length, 0);
      assert.equal((await call("PUT", "devices/current", bound.access, body)).status, 401);
      assert.equal(
        (
          await call("PUT", "devices/current", siblingSession.access, {
            ...body,
            device_id: sibling,
          })
        ).status,
        200,
      );
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.closeDatabase();
  }
  try {
    const reopened = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(
        reopened.prepare("SELECT remote_id FROM homedesk_bindings WHERE device_id=?").get(sibling)
          ?.remote_id,
        body.remote_id,
      );
    } finally {
      reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
