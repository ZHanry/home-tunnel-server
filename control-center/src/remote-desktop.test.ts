import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import type { Server } from "node:http";
import { WebSocket } from "ws";
import { spawnSync } from "node:child_process";
import type { AuthenticatedActor } from "./types.js";
import type { PublicJwk } from "./rd/crypto.js";
import type { RdIdentity, Permission } from "./rd/service.js";

const directory = mkdtempSync(join(tmpdir(), "home-tunnel-rd-"));
const serverKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
writeFileSync(
  join(directory, "rd-key.pem"),
  serverKey.privateKey.export({ type: "pkcs8", format: "pem" }),
  { mode: 0o600 },
);
process.env.NODE_ENV = "test";
process.env.SQLITE_PATH = ":memory:";
process.env.COOKIE_SECURE = "false";
process.env.INTERNAL_SERVICE_KEY = "11".repeat(32);
process.env.FRPS_PLUGIN_KEY = "22".repeat(32);
process.env.LEASE_SIGNING_KEY = "33".repeat(32);
process.env.RD_ENABLED = "true";
process.env.RD_SIGNING_KEY_FILE = join(directory, "rd-key.pem");
process.env.PUBLIC_BASE_URL = "https://console.tunnel.example.com";
const [
  { createApplication },
  db,
  rd,
  crypto,
  { issueSession },
  { attachRealtime },
  { attachRdSignaling, candidateAllowed },
] = await Promise.all([
  import("./server.js"),
  import("./db.js"),
  import("./rd/service.js"),
  import("./rd/crypto.js"),
  import("./http.js"),
  import("./realtime.js"),
  import("./rd/signaling.js"),
]);
let server: Server,
  origin: string,
  actor: AuthenticatedActor,
  accountToken: string,
  stopRealtime: () => Promise<void>,
  stopRd: () => Promise<void>;
type Peer = {
  privateKey: KeyObject;
  publicKey: PublicJwk;
  identity: RdIdentity;
  token: string;
  nonce: string;
};
let controller: Peer, hosts: Peer[];
const signature = (key: KeyObject, payload: unknown, typ = "ht-rd-proof+jwt", jwk?: PublicJwk) => {
  const header = Buffer.from(
      JSON.stringify({ alg: "ES256", typ, ...(jwk ? { jwk } : {}) }),
    ).toString("base64url"),
    body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.${sign("sha256", Buffer.from(`${header}.${body}`), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
};
async function newPeer(kind: "host" | "controller", index: number): Promise<Peer> {
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" }),
    publicKey = crypto.publicJwk(keys.publicKey.export({ format: "jwk" }));
  const device = kind === "host" ? randomUUID() : undefined;
  if (device)
    await db.query(
      "INSERT INTO devices(id,user_id,name,install_id,fingerprint_hash,credential_hash) VALUES(?,?,?,?,?,?)",
      [device, actor.userId, `Host ${index}`, randomUUID(), randomUUID(), randomUUID()],
    );
  const challenge = await rd.enrollmentChallenge(actor, {
    endpoint_kind: kind === "host" ? "desktop" : "browser",
    role: kind,
    public_jwk: publicKey,
    linked_device_id: device,
  });
  const enrolled = await rd.enroll(actor, {
    challenge_id: challenge.challenge_id,
    signed_proof: signature(keys.privateKey, challenge.proof_payload),
    name: `Peer ${index}`,
    platform: kind === "host" ? "windows" : "browser",
  });
  const identity = await rd.tokenIdentity(enrolled.token),
    peer = {
      privateKey: keys.privateKey,
      publicKey,
      identity,
      token: enrolled.token,
      nonce: enrolled.dpop_nonce,
    };
  if (kind === "host") {
    const capabilities = {
      permissions: [...rd.permissions],
      unattended_enabled: false,
      displays: [{ id: "display-1", name: "Main", width: 1920, height: 1080 }],
      codecs: ["H264", "VP8"],
      status: "ready",
    };
    const payload = {
      endpoint_id: identity.endpoint.id,
      local_enabled: true,
      capability_version: 1,
      capabilities,
    };
    await rd.updateCapabilities(identity, {
      ...payload,
      signed_proof: signature(keys.privateKey, payload, "ht-rd-capabilities+jwt"),
    });
    peer.identity = await rd.tokenIdentity(peer.token);
  }
  return peer;
}
async function pair(host: Peer, permissions: Permission[] = ["view", "input.pointer"]) {
  const requestId = randomUUID();
  const pairing = await rd.createPairing(controller.identity, {
    host_endpoint_id: host.identity.endpoint.id,
    session_request_id: requestId,
    permissions,
    mode: "one_session",
    nonce_controller: randomBytes(32).toString("base64url"),
  });
  const transcript = { ...pairing.transcript, nonce_host: randomBytes(32).toString("base64url") };
  const grant = {
    id: pairing.id,
    server_instance_id: transcript.server_instance_id,
    owner_user_id: actor.userId,
    host_endpoint_id: host.identity.endpoint.id,
    controller_endpoint_id: controller.identity.endpoint.id,
    host_jkt: host.identity.endpoint.jkt,
    controller_jkt: controller.identity.endpoint.jkt,
    scope: permissions,
    mode: "one_session",
    one_session_request_id: requestId,
    grant_version: 1,
    expires_at: null,
  };
  await rd.confirmPairing(host.identity, pairing.id, {
    nonce_host: transcript.nonce_host,
    signed_proof: signature(host.privateKey, transcript, "ht-rd-pairing+jwt"),
    grant_jws: signature(host.privateKey, grant, "ht-rd-grant+jwt"),
  });
  await rd.confirmPairing(controller.identity, pairing.id, {
    signed_proof: signature(controller.privateKey, transcript, "ht-rd-pairing+jwt"),
  });
  return { requestId, grantId: pairing.id };
}
async function create(host: Peer) {
  const grant = await pair(host);
  const body = {
    host_endpoint_id: host.identity.endpoint.id,
    grant_id: grant.grantId,
    permissions: ["view", "input.pointer"] as Permission[],
    display_id: "display-1",
    protocol: { major: 1, minor: 0 },
  };
  const session = await rd.createSession(controller.identity, grant.requestId, body);
  return { session, body, grant };
}
async function approve(host: Peer, id: string, version: number) {
  const payload = {
    type: "session.decision",
    session_id: id,
    connection_epoch: 1,
    decision: "accept" as const,
    grant_version: 1,
    permissions: ["view", "input.pointer"] as Permission[],
    expected_version: version,
  };
  return rd.decideSession(host.identity, id, {
    ...payload,
    signed_proof: signature(host.privateKey, payload, "ht-rd-session+jwt"),
  });
}
function dpop(peer: Peer, path: string, method = "GET", jti = randomUUID()) {
  return {
    authorization: `DPoP ${peer.token}`,
    dpop: signature(
      peer.privateKey,
      {
        htu: process.env.PUBLIC_BASE_URL + path,
        htm: method,
        iat: Math.floor(Date.now() / 1000),
        jti,
        ath: crypto.digest(peer.token),
        nonce: peer.nonce,
      },
      "dpop+jwt",
      peer.publicKey,
    ),
  };
}
before(async () => {
  await db.migrate();
  await rd.initializeRd();
  const app = await createApplication(false);
  const userId = randomUUID();
  const session = await db.transaction(async (client) => {
    await client.query(
      "INSERT INTO users(id,username,display_name,password_hash,password_state,role) VALUES(?,?,?,'fixture','normal','user')",
      [userId, "rd-tests", "RD tests"],
    );
    const result = await issueSession(client, { id: userId, token_version: 1 }, null);
    await client.query("UPDATE sessions SET rd_verified_at=home_tunnel_now() WHERE id=?", [
      result.sessionId,
    ]);
    return result;
  });
  accountToken = session.accessToken;
  actor = {
    sessionId: session.sessionId,
    userId,
    deviceId: null,
    username: "rd-tests",
    displayName: "RD tests",
    role: "user",
    status: "active",
    passwordState: "normal",
    tokenVersion: 1,
    csrfTokenHash: "unused",
    authSource: "bearer",
  };
  controller = await newPeer("controller", 0);
  hosts = [];
  for (let i = 0; i < 5; i++) hosts.push(await newPeer("host", i));
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
  stopRealtime = attachRealtime(server).close;
  stopRd = attachRdSignaling(server).close;
});
after(async () => {
  await stopRealtime?.();
  await stopRd?.();
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.closeDatabase();
  await rm(directory, { recursive: true, force: true });
});

test("strict JSON and ES256 reject duplicate fields, unsafe numbers and key substitution", () => {
  assert.throws(() => crypto.strictJson('{"a":1,"a":2}'));
  assert.throws(() => crypto.strictJson('{"a":1e999}'));
  assert.throws(() => crypto.strictJson('{"a":9007199254740992}'));
  assert.equal(crypto.canonical({ z: 1, a: 2 }), '{"a":2,"z":1}');
  const proof = signature(controller.privateKey, { purpose: "test" });
  assert.equal(crypto.verifyJws(proof, controller.publicKey, "ht-rd-proof+jwt").purpose, "test");
  assert.throws(() => crypto.verifyJws(proof, hosts[0]!.publicKey, "ht-rd-proof+jwt"));
  assert.throws(() => crypto.verifyJws(proof, controller.publicKey, "ht-rd-ticket+jwt"));
});
test("RD parser runs before global parser; copied tokens and replayed DPoP do not authenticate", async () => {
  const path = "/api/v1/rd/endpoints",
    headers = dpop(controller, path);
  let response = await fetch(origin + path, { headers });
  assert.equal(response.status, 200);
  await response.text();
  response = await fetch(origin + path, { headers });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error_code, "RD_PROOF_REPLAY");
  response = await fetch(origin + path, {
    headers: { authorization: `Bearer ${controller.token}` },
  });
  assert.equal(response.status, 401);
  await response.text();
  response = await fetch(origin + path, { headers: { authorization: `DPoP ${controller.token}` } });
  assert.equal(response.status, 401);
  await response.text();
  response = await fetch(origin + "/api/v1/rd/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x: "x".repeat(17000) }),
  });
  assert.equal(response.status, 413);
  await response.text();
  response = await fetch(origin + "/api/v1/rd/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"id":1,"id":2}',
  });
  assert.equal(response.status, 400);
  await response.text();
  response = await fetch(origin + "/api/v1/rd/unknown");
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error_code, "RD_NOT_FOUND");
});
test("single-use challenges and device-scoped credentials cannot enroll controllers", async () => {
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" }),
    jwk = crypto.publicJwk(keys.publicKey.export({ format: "jwk" }));
  await assert.rejects(
    rd.enrollmentChallenge(
      { ...actor, deviceId: hosts[0]!.identity.endpoint.linked_device_id },
      { endpoint_kind: "browser", role: "controller", public_jwk: jwk },
    ),
    /账号管理/,
  );
  const challenge = await rd.tokenChallenge(
    controller.identity.endpoint.id,
    "controller_refresh",
    actor,
  );
  const body = {
    endpoint_id: controller.identity.endpoint.id,
    challenge_id: challenge.challenge_id,
    proof: signature(controller.privateKey, challenge.proof_payload),
  };
  const next = await rd.refreshToken(body, actor);
  assert.ok(next.token);
  await assert.rejects(rd.refreshToken(body, actor), /挑战/);
  await assert.rejects(
    rd.tokenIdentity(hosts[0]!.token).then((identity) =>
      rd.createPairing(identity, {
        host_endpoint_id: hosts[1]!.identity.endpoint.id,
        session_request_id: randomUUID(),
        permissions: ["view"],
        mode: "one_session",
        nonce_controller: randomBytes(32).toString("base64url"),
      }),
    ),
    /控制端/,
  );
});

test("host can refresh with only device key while controllers require a parent account", async () => {
  const host = hosts[0]!;
  const challengeResponse = await fetch(origin + "/api/v1/rd/token-challenges", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint_id: host.identity.endpoint.id, purpose: "host_online" }),
  });
  assert.equal(challengeResponse.status, 201);
  const challenge = (await challengeResponse.json()) as {
    challenge_id: string;
    proof_payload: unknown;
  };
  const refreshed = await fetch(origin + "/api/v1/rd/tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      endpoint_id: host.identity.endpoint.id,
      challenge_id: challenge.challenge_id,
      proof: signature(host.privateKey, challenge.proof_payload),
    }),
  });
  assert.equal(refreshed.status, 200);
  assert.ok((await refreshed.json()).token);
  const denied = await fetch(origin + "/api/v1/rd/token-challenges", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      endpoint_id: controller.identity.endpoint.id,
      purpose: "controller_refresh",
    }),
  });
  assert.equal(denied.status, 401);
  await denied.text();
});
test("four distinct windows atomically reserve slots; one host has one controller; authorized close holds slots", async () => {
  const created = [];
  for (const host of hosts.slice(0, 4)) created.push(await create(host));
  assert.equal(
    (await db.one<{ count: number }>("SELECT count(*) AS count FROM rd_session_slots"))?.count,
    8,
  );
  const first = created[0]!;
  assert.equal(
    (await rd.createSession(controller.identity, first.grant.requestId, first.body)).session_id,
    first.session.session_id,
  );
  await assert.rejects(
    rd.createSession(controller.identity, first.grant.requestId, {
      ...first.body,
      display_id: "different",
    }),
    /幂等键/,
  );
  const fifth = await pair(hosts[4]!);
  await assert.rejects(
    rd.createSession(controller.identity, fifth.requestId, {
      ...first.body,
      host_endpoint_id: hosts[4]!.identity.endpoint.id,
      grant_id: fifth.grantId,
    }),
    /数量/,
  );
  const authorized = await approve(
    hosts[0]!,
    first.session.session_id,
    first.session.state_version,
  );
  assert.equal(authorized.state, "authorized");
  assert.ok("ticket_jws" in authorized && authorized.ticket_jws);
  assert.equal(
    crypto.verifyJws(
      (authorized as { lease_jws: string }).lease_jws,
      crypto.serverPublicKey(),
      "ht-rd-lease+jwt",
    ).lease_seq,
    1,
  );
  await rd.closeSession(
    actor.userId,
    first.session.session_id,
    "RD_CANCELLED",
    controller.identity.endpoint.id,
  );
  assert.equal(
    (
      await db.one<{ count: number }>(
        "SELECT count(*) AS count FROM rd_session_slots WHERE session_id=?",
        [first.session.session_id],
      )
    )?.count,
    2,
  );
  const proof = {
    type: "session.close_ack",
    session_id: first.session.session_id,
    connection_epoch: 1,
    lease_seq: 1,
    stopped: true,
  };
  await rd.closeAck(hosts[0]!.identity, first.session.session_id, {
    ...proof,
    signed_proof: signature(hosts[0]!.privateKey, proof, "ht-rd-session+jwt"),
  });
  assert.equal(
    (
      await db.one<{ count: number }>(
        "SELECT count(*) AS count FROM rd_session_slots WHERE session_id=?",
        [first.session.session_id],
      )
    )?.count,
    0,
  );
  for (const item of created.slice(1))
    await rd.closeSession(
      actor.userId,
      item.session.session_id,
      "RD_CANCELLED",
      controller.identity.endpoint.id,
    );
});
test("both ready reports are required; reconnect changes epoch without extending original lease", async () => {
  const created = await create(hosts[0]!);
  let session = await approve(hosts[0]!, created.session.session_id, 1);
  await assert.rejects(
    rd.reportSession(hosts[0]!.identity, session.session_id, {
      phase: "ready",
      connection_epoch: 1,
      expected_version: session.state_version,
      path_verified: false,
    }),
    /UDP/,
  );
  session = await rd.reportSession(hosts[0]!.identity, session.session_id, {
    phase: "ready",
    connection_epoch: 1,
    expected_version: session.state_version,
    path_verified: true,
  });
  assert.equal(session.state, "connecting");
  session = await rd.reportSession(controller.identity, session.session_id, {
    phase: "ready",
    connection_epoch: 1,
    expected_version: session.state_version,
  });
  assert.equal(session.state, "active");
  const expiry = rd.timestamp(session.lease_expires_at),
    id = session.session_id;
  session = await rd.reconnectSession(controller.identity, id, randomUUID(), {
    expected_epoch: 1,
    reason: "network_changed",
  });
  assert.equal(session.connection_epoch, 2);
  assert.equal(session.state, "reconnecting");
  assert.equal(rd.timestamp(session.lease_expires_at), expiry);
  assert.equal((session as { ticket_jws: string | null }).ticket_jws, null);
  await assert.rejects(
    rd.reconnectSession(controller.identity, id, randomUUID(), {
      expected_epoch: 1,
      reason: "network_changed",
    }),
    /重建/,
  );
  await db.query("UPDATE rd_sessions SET lease_expires_at=? WHERE id=?", [
    new Date(Date.now() - 1),
    id,
  ]);
  await db.transaction(rd.cleanupRd);
  assert.equal((await rd.getSession(actor.userId, id)).state, "expired");
  assert.equal(
    (
      await db.one<{ count: number }>(
        "SELECT count(*) AS count FROM rd_session_slots WHERE session_id=?",
        [id],
      )
    )?.count,
    0,
  );
});
test("database rollback cannot publish authorization or ghost lease", async () => {
  const created = await create(hosts[0]!);
  await assert.rejects(
    db.transaction(async (client) => {
      await client.query(
        "UPDATE rd_sessions SET lease_jws='must-not-escape',state='authorized' WHERE id=?",
        [created.session.session_id],
      );
      throw new Error("injected disk failure before commit");
    }),
    /disk failure/,
  );
  const row = await db.one<{ state: string; lease_jws: string | null }>(
    "SELECT state,lease_jws FROM rd_sessions WHERE id=?",
    [created.session.session_id],
  );
  assert.equal(row?.state, "pending_approval");
  assert.equal(row?.lease_jws, null);
  await rd.closeSession(actor.userId, created.session.session_id, "RD_CANCELLED");
});
test("UDP candidates preserve LAN/mDNS and reject relay, TCP and loopback", () => {
  assert.equal(candidateAllowed("candidate:1 1 udp 123 192.168.1.1 12345 typ host"), true);
  assert.equal(candidateAllowed("candidate:1 1 udp 123 device-123.local 12345 typ host"), true);
  assert.equal(
    candidateAllowed("candidate:1 1 tcp 123 192.168.1.1 12345 typ host tcptype active"),
    false,
  );
  assert.equal(candidateAllowed("candidate:1 1 udp 123 192.168.1.1 12345 typ relay"), false);
  assert.equal(candidateAllowed("candidate:1 1 udp 123 127.0.0.1 12345 typ host"), false);
  assert.equal(candidateAllowed("candidate:1 1 udp 123 ff12.local 12345 typ host"), true);
  assert.equal(candidateAllowed("candidate:1 1 udp 123 ::ffff:127.0.0.1 12345 typ host"), false);
  assert.equal(candidateAllowed("candidate:1 1 udp 123 192.168.1.1 65536 typ host"), false);
});

test("configuration defaults off and refuses relay, unknown options and invalid STUN ports", () => {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) if (name.startsWith("RD_")) delete environment[name];
  const source = `const {rdConfig}=await import(${JSON.stringify(new URL("./rd/config.js", import.meta.url).href)});process.stdout.write(String(rdConfig.enabled))`;
  const execute = (values: Record<string, string>) =>
    spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      env: { ...environment, ...values },
      encoding: "utf8",
    });
  const disabled = execute({});
  assert.equal(disabled.status, 0);
  assert.equal(disabled.stdout, "false");
  for (const options of [
    { RD_ALLOW_TURN: "true" },
    { RD_ALLOW_ICE_TCP: "true" },
    { RD_UDP_ONLY: "false" },
    { RD_STUN_URLS: "turn:example.com:3478" },
    { RD_STUN_URLS: "stun:example.com:65536" },
    { RD_UNKNOWN: "true" },
  ])
    assert.notEqual(execute(Object.fromEntries(Object.entries(options))).status, 0);
  assert.equal(
    execute({ RD_STUN_URLS: "stun:example.com:3478,stun:[2001:db8::1]:3478" }).status,
    0,
  );
});
test("one upgrade dispatcher supports legacy push and RD single-use ticket authentication", async () => {
  const legacy = new WebSocket(origin.replace("http:", "ws:") + "/api/v1/ws", {
    headers: { authorization: `Bearer ${accountToken}` },
  });
  legacy.on("error", () => undefined);
  await once(legacy, "message");
  const ticket = await rd.signalTicket(controller.identity, "connect");
  const socket = new WebSocket(
    origin.replace("http:", "ws:") + "/api/v1/rd/signal",
    "ht.rd.signal.v1",
  );
  socket.on("error", () => undefined);
  const [data] = await once(socket, "message"),
    challenge = JSON.parse(data.toString()) as { connection_id: string; nonce: string };
  const auth = {
    v: 1,
    type: "auth",
    ticket: ticket.ticket,
    proof: signature(
      controller.privateKey,
      {
        connection_id: challenge.connection_id,
        nonce: challenge.nonce,
        ticket_hash: crypto.digest(ticket.ticket),
        endpoint_id: controller.identity.endpoint.id,
      },
      "ht-rd-signal+jwt",
    ),
  };
  const authenticated = once(socket, "message");
  socket.send(JSON.stringify(auth));
  const [result] = await authenticated;
  assert.equal(JSON.parse(result.toString()).type, "auth.ok");
  const closed = once(socket, "close");
  socket.close();
  await closed;
  const oldClosed = once(legacy, "close");
  legacy.close();
  await oldClosed;
  assert.equal(server.listenerCount("upgrade"), 1);
  await assert.rejects(
    rd.authenticateSignal(ticket.ticket, auth.proof, challenge.connection_id, challenge.nonce),
    /挑战/,
  );
});
test("signed peer messages reach only the paired peer, reject TCP candidates and reject replay", async () => {
  const created = await create(hosts[0]!);
  const session = await approve(hosts[0]!, created.session.session_id, 1);
  const waitFor = (socket: WebSocket, type: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off("message", onMessage);
        reject(new Error(`No ${type} message`));
      }, 3000);
      function onMessage(data: Buffer) {
        const value = JSON.parse(data.toString()) as Record<string, unknown>;
        if (value.type === type) {
          clearTimeout(timer);
          socket.off("message", onMessage);
          resolve(value);
        }
      }
      socket.on("message", onMessage);
    });
  const connect = async (peer: Peer) => {
    const ticket = await rd.signalTicket(peer.identity, "connect");
    const socket = new WebSocket(
      origin.replace("http:", "ws:") + "/api/v1/rd/signal",
      "ht.rd.signal.v1",
    );
    socket.on("error", () => undefined);
    const challenge = await waitFor(socket, "auth.challenge"),
      authenticated = waitFor(socket, "auth.ok");
    socket.send(
      JSON.stringify({
        v: 1,
        type: "auth",
        ticket: ticket.ticket,
        proof: signature(
          peer.privateKey,
          {
            connection_id: challenge.connection_id,
            nonce: challenge.nonce,
            ticket_hash: crypto.digest(ticket.ticket),
            endpoint_id: peer.identity.endpoint.id,
          },
          "ht-rd-signal+jwt",
        ),
      }),
    );
    await authenticated;
    return socket;
  };
  const hostSocket = await connect(hosts[0]!),
    controllerSocket = await connect(controller);
  try {
    const claims = crypto.verifyJws(
      (session as { ticket_jws: string }).ticket_jws,
      crypto.serverPublicKey(),
      "ht-rd-ticket+jwt",
    );
    const payload = {
      v: 1,
      type: "peer.offer",
      session_id: session.session_id,
      connection_epoch: 1,
      from_endpoint_id: controller.identity.endpoint.id,
      to_endpoint_id: hosts[0]!.identity.endpoint.id,
      seq: "1",
      ticket_jti: claims.jti,
      created_at: new Date().toISOString(),
      payload: { type: "offer", sdp: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n" },
    };
    const compact = signature(controller.privateKey, payload, "ht-rd-peer+jwt"),
      envelope = {
        v: 1,
        type: "peer.offer",
        request_id: randomUUID(),
        session_id: session.session_id,
        connection_epoch: 1,
        payload_jws: compact,
      };
    const forwarded = waitFor(hostSocket, "peer.offer");
    controllerSocket.send(JSON.stringify(envelope));
    assert.equal((await forwarded).payload_jws, compact);
    const rejected = waitFor(controllerSocket, "error");
    controllerSocket.send(
      JSON.stringify({
        ...envelope,
        type: "peer.candidates",
        request_id: randomUUID(),
        payload_jws: signature(
          controller.privateKey,
          {
            ...payload,
            type: "peer.candidates",
            seq: "2",
            payload: {
              candidates: [
                {
                  candidate: "candidate:1 1 tcp 123 192.168.1.1 12345 typ host tcptype active",
                  sdpMid: "0",
                  sdpMLineIndex: 0,
                },
              ],
            },
          },
          "ht-rd-peer+jwt",
        ),
      }),
    );
    assert.equal((await rejected).error_code, "RD_NO_DIRECT_PATH");
    const replay = waitFor(controllerSocket, "error");
    controllerSocket.send(JSON.stringify(envelope));
    assert.equal((await replay).error_code, "RD_PROOF_REPLAY");
    await assert.rejects(rd.getSession(randomUUID(), session.session_id), /不存在/);
  } finally {
    hostSocket.terminate();
    controllerSocket.terminate();
    await db.query("UPDATE rd_sessions SET lease_expires_at=? WHERE id=?", [
      new Date(Date.now() - 1),
      session.session_id,
    ]);
    await db.transaction(rd.cleanupRd);
  }
});

test("HTTP accounts actual JSON bytes and exhausted business budget still permits safe closure", async () => {
  const usage = () =>
    db.one<{ business_in_bytes: number; business_out_bytes: number; reserved_bytes: number }>(
      "SELECT * FROM rd_usage_daily WHERE owner_user_id=? AND date_utc=?",
      [actor.userId, new Date().toISOString().slice(0, 10)],
    );
  const before = await usage();
  const response = await fetch(origin + "/api/v1/rd/server-keys", {
    headers: { authorization: `Bearer ${accountToken}` },
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(
    (await usage())!.business_out_bytes - (before?.business_out_bytes ?? 0),
    Buffer.byteLength(text),
  );
  const reservedBefore = (await usage())!.reserved_bytes,
    body = JSON.stringify({ purpose: "connect" });
  const tokenResponse = await fetch(origin + "/api/v1/rd/signal-tickets", {
    method: "POST",
    headers: {
      ...dpop(controller, "/api/v1/rd/signal-tickets", "POST"),
      "content-type": "application/json",
    },
    body,
  });
  assert.equal(tokenResponse.status, 201);
  const tokenBody = await tokenResponse.text();
  assert.equal(
    (await usage())!.reserved_bytes - reservedBefore,
    Buffer.byteLength(body) + Buffer.byteLength(tokenBody),
  );
  const created = await create(hosts[0]!);
  try {
    await db.query(
      "UPDATE rd_usage_daily SET business_in_bytes=20971520,business_out_bytes=0 WHERE owner_user_id=?",
      [actor.userId],
    );
    const blocked = await fetch(origin + "/api/v1/rd/server-keys", {
      headers: { authorization: `Bearer ${accountToken}` },
    });
    assert.equal(blocked.status, 429);
    await assert.rejects(create(hosts[1]!), /预算/);
    const path = `/api/v1/rd/sessions/${created.session.session_id}/close`;
    const closed = await fetch(origin + path, {
      method: "POST",
      headers: { ...dpop(controller, path, "POST"), "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(closed.status, 204);
    assert.equal(
      (
        await rd.getSession(
          actor.userId,
          created.session.session_id,
          controller.identity.endpoint.id,
        )
      ).state,
      "closed",
    );
  } finally {
    await db.query(
      "UPDATE rd_usage_daily SET business_in_bytes=0,business_out_bytes=0 WHERE owner_user_id=?",
      [actor.userId],
    );
  }
});

test("account revocation atomically invalidates tokens and stops renewal without releasing active slots", async () => {
  const created = await create(hosts[0]!);
  await approve(hosts[0]!, created.session.session_id, 1);
  await db.query("UPDATE users SET token_version=token_version+1 WHERE id=?", [actor.userId]);
  await assert.rejects(rd.tokenIdentity(controller.token), /失效/);
  const row = await db.one<{ state: string }>("SELECT state FROM rd_sessions WHERE id=?", [
    created.session.session_id,
  ]);
  assert.equal(row?.state, "closing");
  assert.equal(
    (
      await db.one<{ count: number }>(
        "SELECT count(*) AS count FROM rd_session_slots WHERE session_id=?",
        [created.session.session_id],
      )
    )?.count,
    2,
  );
});
