import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import test, { after, before } from "node:test";
import { WebSocket } from "ws";

process.env.NODE_ENV = "test";
process.env.SQLITE_PATH = ":memory:";
process.env.INTERNAL_SERVICE_KEY ??= "11".repeat(32);
process.env.FRPS_PLUGIN_KEY ??= "22".repeat(32);
process.env.LEASE_SIGNING_KEY ??= "33".repeat(32);
process.env.COOKIE_SECURE = "false";
process.env.PUBLIC_BASE_URL = "https://console.tunnel.example.com";

const [{ migrate, closeDatabase, transaction }, { issueSession }, realtime] = await Promise.all([
  import("./db.js"),
  import("./http.js"),
  import("./realtime.js"),
]);

let server: Server;
let closeRealtime: () => Promise<void>;
let origin: string;
let accessToken: string;
let userId: string;

before(async () => {
  await migrate();
  userId = "11111111-1111-4111-8111-111111111111";
  const session = await transaction(async (client) => {
    await client.query(
      `INSERT INTO users(id,username,display_name,password_hash,password_state,role)
       VALUES(?,?,?,?,'normal','user')`,
      [userId, "realtime-test", "Realtime test", "test-only-password-hash"],
    );
    return issueSession(client, { id: userId, token_version: 1 }, null);
  });
  accessToken = session.accessToken;

  server = createServer();
  ({ close: closeRealtime } = realtime.attachRealtime(server, {
    // Keep this deliberately small so the regression test exercises the
    // production code path without generating an unbounded/OOM-style input.
    maxBufferedChunks: 3,
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `ws://127.0.0.1:${address.port}/api/v1/ws`;
});

after(async () => {
  await closeRealtime();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeDatabase();
});

async function connect(token = accessToken): Promise<WebSocket> {
  const socket = new WebSocket(origin, { headers: { authorization: `Bearer ${token}` } });
  socket.on("error", () => undefined);
  const connected = once(socket, "message");
  await once(socket, "open");
  await connected;
  return socket;
}

async function expectUpgradeRejected(
  headers: Record<string, string>,
  expectedStatus: number,
): Promise<void> {
  const socket = new WebSocket(origin, { headers });
  socket.on("error", () => undefined);
  const [request, response] = await once(socket, "unexpected-response");
  assert.ok(request);
  assert.equal(response.statusCode, expectedStatus);
  response.resume();
  await once(response, "end");
}

async function waitForClientCount(expected: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (realtime.getWebsocketClientCount() !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(realtime.getWebsocketClientCount(), expected);
}

function transportFor(socket: WebSocket): Socket {
  const transport = (socket as WebSocket & { _socket?: Socket })._socket;
  assert.ok(transport, "WebSocket transport is unavailable");
  return transport;
}

function maskedTextFrame(payload: Buffer): { header: Buffer; body: Buffer } {
  assert.ok(payload.length > 0 && payload.length <= 125);
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const body = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    body.writeUInt8(payload.readUInt8(index) ^ mask.readUInt8(index % mask.length), index);
  }
  return {
    header: Buffer.from([0x81, 0x80 | payload.length, ...mask]),
    body,
  };
}

test("reassembles fragmented client messages below the payload limit", async () => {
  const socket = await connect();
  try {
    socket.send("pi", { fin: false });
    socket.send("ng", { fin: true });
    const [message] = await once(socket, "message");
    assert.equal(message.toString(), "pong");
  } finally {
    socket.close();
    await once(socket, "close");
  }
  await waitForClientCount(0);
});

test("publishes and marks a recipient outbox event delivered", async () => {
  const socket = await connect();
  const delivered = once(socket, "message");
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO outbox_events(
         event_type,resource_type,resource_id,resource_version,recipient_user_id,payload
       ) VALUES(?,?,?,?,?,?)`,
      ["test.updated", "test", "resource-1", 7, userId, { ok: true }],
    );
  });

  const [message] = await delivered;
  const event = JSON.parse(message.toString()) as {
    event: string;
    resource_id: string;
    resource_version: number;
    payload: { ok: boolean };
  };
  assert.equal(event.event, "test.updated");
  assert.equal(event.resource_id, "resource-1");
  assert.equal(event.resource_version, 7);
  assert.deepEqual(event.payload, { ok: true });

  socket.close();
  await once(socket, "close");
  await waitForClientCount(0);
});

test("administrator device sockets only receive their own device events while management sees both", async () => {
  const owner = "22222222-2222-4222-8222-222222222222";
  const first = "33333333-3333-4333-8333-333333333333";
  const second = "44444444-4444-4444-8444-444444444444";
  const sessions = await transaction(async (client) => {
    await client.query(
      "INSERT INTO users(id,username,display_name,password_hash,password_state,role) VALUES(?,?,?,?,'normal','admin')",
      [owner, "socket-owner", "Owner", "hash"],
    );
    for (const id of [first, second])
      await client.query(
        "INSERT INTO devices(id,user_id,name,install_id,fingerprint_hash,credential_hash) VALUES(?,?,?,?,?,?)",
        [id, owner, id, id, id, id],
      );
    return [
      await issueSession(client, { id: owner, token_version: 1 }, first),
      await issueSession(client, { id: owner, token_version: 1 }, null),
    ];
  });
  const local = await connect(sessions[0]!.accessToken);
  const manager = await connect(sessions[1]!.accessToken);
  const localIds: string[] = [],
    managerIds: string[] = [];
  local.on("message", (data) => localIds.push(JSON.parse(data.toString()).resource_id));
  manager.on("message", (data) => managerIds.push(JSON.parse(data.toString()).resource_id));
  const received = once(local, "message");
  try {
    await transaction(async (client) => {
      for (const device of [second, first])
        await client.query(
          "INSERT INTO outbox_events(event_type,resource_type,resource_id,resource_version,recipient_user_id,recipient_device_id,payload) VALUES('connection.command','Connection',?,1,?,?,?)",
          [device, owner, device, { action: "update" }],
        );
    });
    await received;
    assert.deepEqual(localIds, [first]);
    // The manager's messages are on a separate socket; its last event is our barrier.
    if (managerIds.length < 2) await once(manager, "message");
    assert.deepEqual(managerIds, [second, first]);
  } finally {
    local.close();
    manager.close();
    await Promise.all([once(local, "close"), once(manager, "close")]);
  }
});

test("accepts a same-origin cookie-authenticated upgrade", async () => {
  const socket = new WebSocket(origin, {
    headers: {
      cookie: `ht_access=${accessToken}`,
      origin: "https://console.tunnel.example.com",
    },
  });
  socket.on("error", () => undefined);
  const connected = once(socket, "message");
  await once(socket, "open");
  await connected;
  socket.close();
  await once(socket, "close");
  await waitForClientCount(0);
});

test("rejects cookie-authenticated upgrades from another origin", async () => {
  await expectUpgradeRejected(
    {
      cookie: `ht_access=${accessToken}`,
      origin: "https://evil.tunnel.example.com",
    },
    403,
  );
  await waitForClientCount(0);
});

test("rejects cookie-authenticated upgrades without an origin", async () => {
  await expectUpgradeRejected({ cookie: `ht_access=${accessToken}` }, 403);
  await waitForClientCount(0);
});

test("accepts an originless bearer-authenticated upgrade", async () => {
  const socket = await connect();
  socket.close();
  await once(socket, "close");
  await waitForClientCount(0);
});

test("ignores upgrade requests outside the realtime endpoint", async () => {
  const socket = new WebSocket(origin.replace("/api/v1/ws", "/api/v1/not-realtime"));
  socket.on("error", () => undefined);
  const [request, response] = await once(socket, "unexpected-response");
  assert.ok(request);
  assert.equal(response.statusCode, 404);
  response.resume();
  await once(response, "end");
});

test("disconnects when a fragmented message exceeds the complete-message limit", async () => {
  const socket = await connect();
  socket.once("error", () => undefined);
  socket.send(Buffer.alloc(realtime.REALTIME_MAX_PAYLOAD_BYTES, 0x61), { fin: false });
  socket.send(Buffer.from("b"), { fin: true });

  const [code] = await once(socket, "close");
  assert.equal(code, 1009);
  await waitForClientCount(0);
  const replacement = await connect();
  replacement.close();
  await once(replacement, "close");
  await waitForClientCount(0);
});

test("disconnects when a message exceeds the fragment-count limit", async () => {
  const socket = await connect();
  socket.once("error", () => undefined);
  for (let index = 0; index <= realtime.REALTIME_MAX_FRAGMENTS; index += 1) {
    if (socket.readyState !== WebSocket.OPEN) break;
    socket.send("x", { fin: false });
  }

  const [code] = await once(socket, "close");
  assert.equal(code, 1008);
  await waitForClientCount(0);
  const replacement = await connect();
  replacement.close();
  await once(replacement, "close");
  await waitForClientCount(0);
});

test("disconnects when an incomplete frame exceeds the buffered-chunk limit", async () => {
  const socket = await connect();
  const transport = transportFor(socket);
  transport.setNoDelay(true);
  const closeEvent = once(socket, "close");
  const frame = maskedTextFrame(Buffer.from("chunked-input"));

  // Send a valid masked frame header followed by one payload byte per turn.
  // The receiver must retain these incomplete pieces until the advertised
  // payload is complete, which deterministically exercises maxBufferedChunks.
  transport.write(Buffer.concat([frame.header, frame.body.subarray(0, 1)]));
  for (let index = 1; index < frame.body.length && !transport.destroyed; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    transport.write(frame.body.subarray(index, index + 1));
  }

  const [code] = await closeEvent;
  assert.equal(code, 1008);
  await waitForClientCount(0);
  const replacement = await connect();
  replacement.close();
  await once(replacement, "close");
  await waitForClientCount(0);
});

test("reclaims a client after an abrupt transport disconnect", async () => {
  const socket = await connect();
  const closeEvent = once(socket, "close");
  transportFor(socket).destroy();

  const [code] = await closeEvent;
  assert.equal(code, 1006);
  await waitForClientCount(0);
  const replacement = await connect();
  replacement.close();
  await once(replacement, "close");
  await waitForClientCount(0);
});

test("rejects unauthenticated upgrades without establishing a WebSocket", async () => {
  const socket = new WebSocket(origin);
  socket.on("error", () => undefined);
  const [request, response] = await once(socket, "unexpected-response");
  assert.ok(request);
  assert.equal(response.statusCode, 401);
  response.resume();
  await once(response, "end");
});
