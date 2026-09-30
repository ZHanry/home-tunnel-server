import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { validateApiResponse } from "./api-contract-test-helper.js";

test("current-device rename is authenticated, isolated and persistent", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "home-tunnel-device-name-"));
  const databasePath = join(directory, "test.sqlite");
  Object.assign(process.env, {
    NODE_ENV: "test",
    SQLITE_PATH: databasePath,
    INTERNAL_SERVICE_KEY: "11".repeat(32),
    FRPS_PLUGIN_KEY: "22".repeat(32),
    LEASE_SIGNING_KEY: "33".repeat(32),
    COOKIE_SECURE: "false",
    BOOTSTRAP_ADMIN_PASSWORD: "Rename-Bootstrap-Q8-safe",
  });
  const { createApplication } = await import("./server.js");
  const db = await import("./db.js");
  const { tokenHash } = await import("./security.js");
  await db.migrate();
  const userId = randomUUID(),
    otherUserId = randomUUID();
  const currentId = randomUUID(),
    siblingId = randomUUID(),
    foreignId = randomUUID();
  for (const [id, username] of [
    [userId, "owner"],
    [otherUserId, "other"],
  ]) {
    await db.query(
      "INSERT INTO users(id,username,display_name,password_hash,password_state,role) VALUES(?,?,?,?,?,?)",
      [id, username, username, "fixture-not-a-password", "normal", "user"],
    );
  }
  for (const [id, owner, name] of [
    [currentId, userId, "Original"],
    [siblingId, userId, "Sibling"],
    [foreignId, otherUserId, "Foreign"],
  ]) {
    await db.query(
      "INSERT INTO devices(id,user_id,name,install_id,fingerprint_hash,credential_hash,tags,favorite) VALUES(?,?,?,?,?,?,?,?)",
      [id, owner, name, randomUUID(), randomUUID(), tokenHash(randomUUID()), '["keep-tag"]', 1],
    );
  }
  const hostId = randomUUID(),
    controllerId = randomUUID(),
    siblingHostId = randomUUID();
  for (const [id, linked, role, name] of [
    [hostId, currentId, "host", "Original"],
    [controllerId, currentId, "controller", "Controller alias"],
    [siblingHostId, siblingId, "host", "Sibling host"],
  ]) {
    await db.query(
      `INSERT INTO rd_endpoints(id,owner_user_id,linked_device_id,kind,role,name,platform,public_jwk,jkt,created_at,updated_at)
       VALUES(?,?,?,'desktop',?,?,'windows','{}',?,home_tunnel_now(),home_tunnel_now())`,
      [id, userId, linked, role, name, randomUUID()],
    );
  }
  async function session(deviceId: string | null, owner = userId) {
    const access = randomUUID(),
      csrf = randomUUID(),
      id = randomUUID();
    await db.query(
      `INSERT INTO sessions(id,user_id,device_id,token_family,token_version,access_token_hash,refresh_token_hash,csrf_token_hash,access_expires_at,refresh_expires_at)
       VALUES(?,?,?,?,1,?,?,?,?,?)`,
      [
        id,
        owner,
        deviceId,
        randomUUID(),
        tokenHash(access),
        tokenHash(randomUUID()),
        tokenHash(csrf),
        new Date(Date.now() + 3600_000).toISOString(),
        new Date(Date.now() + 7200_000).toISOString(),
      ],
    );
    return { id, access, csrf };
  }
  const bound = await session(currentId),
    account = await session(null);
  const mismatched = await session(foreignId),
    foreign = await session(foreignId, otherUserId);
  const server = (await createApplication(false)).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}/api/v1/devices/current/name`;
  async function rename(body: unknown, access?: string, cookie = false, csrf?: string) {
    const response = await fetch(endpoint, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        ...(access
          ? cookie
            ? { cookie: `ht_access=${access}` }
            : { authorization: `Bearer ${access}` }
          : {}),
        ...(csrf ? { "x-csrf-token": csrf } : {}),
      },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    validateApiResponse("PATCH", "/api/v1/devices/current/name", response.status, data);
    return { status: response.status, data };
  }
  try {
    await t.test("requires a device-bound session and CSRF for cookies", async () => {
      assert.equal((await rename({ name: "No" })).status, 401);
      assert.equal((await rename({ name: "No" }, account.access)).status, 403);
      assert.equal((await rename({ name: "No" }, bound.access, true)).status, 403);
      assert.equal(
        (await rename({ name: "Cookie name" }, bound.access, true, bound.csrf)).status,
        200,
      );
    });
    await t.test("remote-window-only sessions cannot rename this computer", async () => {
      await db.query("UPDATE sessions SET client_type='native_remote' WHERE id=?", [bound.id]);
      assert.equal((await rename({ name: "No" }, bound.access)).status, 403);
      await db.query("UPDATE sessions SET client_type='windows' WHERE id=?", [bound.id]);
    });
    await t.test("validates names and refuses user-selected targets", async () => {
      for (const body of [
        {},
        { name: "" },
        { name: " \t\r\n\u2003\uFEFF" },
        { name: "a".repeat(121) },
        { name: "😀".repeat(61) },
        { name: "desk\nname" },
        { name: "desk\u0000" },
        { name: 5 },
        { name: "No", device_id: siblingId },
        { name: "No", user_id: otherUserId },
        { name: "No", tags: [] },
      ])
        assert.equal((await rename(body, bound.access)).status, 400, JSON.stringify(body));
      assert.equal((await rename({ name: "a".repeat(120) }, bound.access)).status, 200);
      assert.equal((await rename({ name: "😀".repeat(60) }, bound.access)).status, 200);
    });
    await t.test(
      "only the caller's current device changes; tags and credentials are untouched",
      async () => {
        const before = await db.one(
          "SELECT credential_hash,config_version,tags,favorite FROM devices WHERE id=?",
          [currentId],
        );
        const result = await rename({ name: "  工作电脑 Office PC  " }, bound.access);
        assert.equal(result.status, 200);
        assert.deepEqual(result.data, { device_id: currentId, device_name: "工作电脑 Office PC" });
        assert.equal(
          (await db.one<{ name: string }>("SELECT name FROM rd_endpoints WHERE id=?", [hostId]))
            ?.name,
          "工作电脑 Office PC",
        );
        assert.equal(
          (
            await db.one<{ name: string }>("SELECT name FROM rd_endpoints WHERE id=?", [
              controllerId,
            ])
          )?.name,
          "Controller alias",
        );
        assert.equal(
          (
            await db.one<{ name: string }>("SELECT name FROM rd_endpoints WHERE id=?", [
              siblingHostId,
            ])
          )?.name,
          "Sibling host",
        );
        assert.deepEqual(
          await db.one(
            "SELECT credential_hash,config_version,tags,favorite FROM devices WHERE id=?",
            [currentId],
          ),
          before,
        );
        assert.equal(
          (await db.one<{ name: string }>("SELECT name FROM devices WHERE id=?", [siblingId]))
            ?.name,
          "Sibling",
        );
        assert.equal(
          (await db.one<{ name: string }>("SELECT name FROM devices WHERE id=?", [foreignId]))
            ?.name,
          "Foreign",
        );
        assert.equal((await rename({ name: "Unauthorized" }, mismatched.access)).status, 423);
        assert.equal(
          (await rename({ name: "Other account's own computer" }, foreign.access)).status,
          200,
        );
        assert.equal(
          (await db.one<{ name: string }>("SELECT name FROM devices WHERE id=?", [currentId]))
            ?.name,
          "工作电脑 Office PC",
        );
      },
    );
    await t.test("revoked devices and sessions cannot rename", async () => {
      await db.query(
        "UPDATE devices SET status='revoked',revoked_at=home_tunnel_now() WHERE id=?",
        [currentId],
      );
      assert.equal((await rename({ name: "No" }, bound.access)).status, 423);
      await db.query("UPDATE devices SET status='active',revoked_at=NULL WHERE id=?", [currentId]);
      await db.query("UPDATE sessions SET revoked_at=home_tunnel_now() WHERE id=?", [bound.id]);
      assert.equal((await rename({ name: "No" }, bound.access)).status, 401);
      assert.equal(
        (await db.one<{ name: string }>("SELECT name FROM devices WHERE id=?", [currentId]))?.name,
        "工作电脑 Office PC",
      );
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.closeDatabase();
  }
  try {
    const reopened = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(
        reopened.prepare("SELECT name FROM devices WHERE id=?").get(currentId)?.name,
        "工作电脑 Office PC",
      );
      assert.ok(
        Number(
          reopened
            .prepare(
              "SELECT count(*) AS count FROM audit_events WHERE action='DeviceRenamed' AND target_id=?",
            )
            .get(currentId)?.count,
        ) >= 1,
      );
    } finally {
      reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
