import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  RD,
  TYPES,
  decodeFrame,
  directCandidate,
  encodeFrame,
  proofTranscript,
  strictJson,
  validateSdp,
} from "../public/modules/remote/protocol.js";
import {
  base64url,
  publicJwk,
  sha256,
  signJws,
  thumbprint,
  unbase64url,
  verifyJws,
  verifyServerKeyset,
} from "../public/modules/remote/identity.js";
import { Sha256Stream } from "../public/modules/remote/sha256-stream.js";
import { RemoteTransfers, safeFilename } from "../public/modules/remote/transfer.js";
import {
  LeaseDeadline,
  PeerReplayWindow,
  selectedUdpPair,
  RemoteSession,
} from "../public/modules/remote/session.js";
import { keyUsage, pointerCoordinates } from "../public/modules/remote/input.js";
import { boundedResponse, RemoteApi } from "../public/modules/remote/http.js";
import { validateJsonBody } from "../public/modules/remote/payload.generated.js";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const vectors = JSON.parse(
  await readFile(new URL("../../contracts/remote-test-vectors.json", import.meta.url), "utf8"),
);
const hex = (value) => Buffer.from(value).toString("hex");

test("all JSON bodies have strict schemas; generated validator agrees with JSON Schema", () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addKeyword({
    keyword: "x-maxEncodedBytes",
    schemaType: "number",
    validate: (maximum, data) => Buffer.byteLength(JSON.stringify(data)) <= maximum,
  });
  ajv.addKeyword({
    keyword: "x-uniqueBy",
    schemaType: "array",
    type: "array",
    validate: (keys, data) =>
      keys.every((key) => new Set(data.map((item) => item[key])).size === data.length),
  });
  ajv.addKeyword({
    keyword: "x-fieldInArray",
    schemaType: "object",
    type: "object",
    validate: (rule, data) =>
      Array.isArray(data[rule.array]) &&
      data[rule.array].some((item) => item[rule.key] === data[rule.field]),
  });
  const counts = { defined: 0, reserved: 0, binary: 0 };
  for (const [name, definition] of Object.entries(RD.messages)) {
    if (definition.encoding === "binary") {
      counts.binary++;
      assert.equal(definition.body_schema, false, name);
      assert.ok(definition.binary_layout.fields.length > 0, name);
      continue;
    }
    if (definition.wire_status === "reserved") {
      counts.reserved++;
      assert.equal(definition.body_schema, false, name);
      assert.throws(() => validateJsonBody(definition.id, {}), /RD_PROTOCOL_MISMATCH/, name);
      continue;
    }
    counts.defined++;
    const validate = ajv.compile({
      $schema: RD.schema_dialect,
      $defs: RD.$defs,
      ...definition.body_schema,
    });
    for (const example of definition.examples) {
      assert.equal(validate(example), true, `${name}: ${JSON.stringify(validate.errors)}`);
      assert.deepEqual(validateJsonBody(definition.id, example), example, name);
      const extra = { ...example, unexpected: true };
      assert.equal(validate(extra), false, name);
      assert.throws(() => validateJsonBody(definition.id, extra), /RD_PROTOCOL_MISMATCH/, name);
      assert.throws(
        () => validateJsonBody(definition.id, example, definition.max_payload_bytes + 1),
        /RD_MESSAGE_TOO_LARGE/,
        name,
      );
      for (const key of Object.keys(example)) {
        const missing = { ...example };
        delete missing[key];
        // The optional variants must be treated identically by both validators.
        const valid = validate(missing);
        if (valid) assert.doesNotThrow(() => validateJsonBody(definition.id, missing), name);
        else
          assert.throws(
            () => validateJsonBody(definition.id, missing),
            /RD_PROTOCOL_MISMATCH/,
            name,
          );
      }
    }
  }
  assert.deepEqual(counts, { defined: 27, reserved: 7, binary: 9 });
});

test("input heartbeat versions increase per epoch and only a current grant resets them", async () => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const visibility = { hidden: false };
  Object.defineProperty(globalThis, "document", { configurable: true, value: visibility });
  try {
    const session = Object.create(RemoteSession.prototype),
      frames = [];
    const requestID = crypto.randomUUID();
    Object.assign(session, {
      lease: { valid: () => true },
      epoch: 1,
      received: new Map(),
      peerVerified: true,
      pathVerified: true,
      ready: true,
      inputRequested: true,
      inputRequestId: requestID,
      inputEnabled: true,
      inputEpoch: 2,
      heartbeatVersion: 0,
      layout: { layout_epoch: 1 },
      inputState: () => ({ keys: [{ usage_page: 7, usage: 4 }], buttons: 1 }),
      send: (type, payload) => {
        validateJsonBody(type, payload);
        frames.push({ type, payload });
      },
    });
    session.sendInputHeartbeat();
    session.sendInputHeartbeat();
    assert.deepEqual(
      frames.map((frame) => frame.payload.state_version),
      [1, 2],
    );
    assert.ok(frames.every((frame) => frame.payload.input_epoch === 2));
    assert.deepEqual(frames[1].payload.keys, [{ usage_page: 7, usage: 4 }]);
    assert.equal(frames[1].payload.buttons, 1);
    await session.onFrame(
      {
        type: TYPES.CONTROL_GRANTED,
        epoch: 1,
        sequence: 1,
        payload: { request_id: crypto.randomUUID(), new_input_epoch: 90 },
      },
      "control",
    );
    assert.equal(session.heartbeatVersion, 2, "stale request must not reset heartbeat history");
    assert.equal(session.inputEpoch, 2);
    await session.onFrame(
      {
        type: TYPES.CONTROL_GRANTED,
        epoch: 1,
        sequence: 2,
        payload: { request_id: requestID, new_input_epoch: 3 },
      },
      "control",
    );
    assert.equal(session.heartbeatVersion, 0);
    assert.equal(session.inputEpoch, 3);
    assert.equal(session.inputEnabled, false, "a new epoch cannot inherit enabled input");
    const beforeACK = frames.length;
    session.sendInputHeartbeat();
    assert.equal(
      frames.length,
      beforeACK,
      "new grant still requires its input synchronization ACK",
    );
    await session.onFrame(
      {
        type: TYPES.INPUT_SYNC_ACK,
        epoch: 1,
        sequence: 3,
        payload: { request_id: requestID, input_epoch: 3, layout_epoch: 1 },
      },
      "control",
    );
    session.sendInputHeartbeat();
    assert.equal(frames.at(-1).payload.state_version, 1);
    assert.equal(frames.at(-1).payload.input_epoch, 3);
    session.inputRequested = false;
    await session.onFrame(
      {
        type: TYPES.CONTROL_GRANTED,
        epoch: 1,
        sequence: 4,
        payload: { request_id: requestID, new_input_epoch: 4 },
      },
      "control",
    );
    assert.equal(session.heartbeatVersion, 1, "released request must not reset heartbeat history");
    assert.equal(session.inputEpoch, 3);
    const count = frames.length;
    visibility.hidden = true;
    session.sendInputHeartbeat();
    assert.equal(frames.length, count, "background page cannot keep input alive");
    visibility.hidden = false;
    session.inputEnabled = false;
    session.sendInputHeartbeat();
    assert.equal(frames.length, count, "disabled input cannot keep the watchdog alive");
    session.inputEnabled = true;
    session.heartbeatVersion = Number.MAX_SAFE_INTEGER;
    assert.throws(() => session.sendInputHeartbeat());
    assert.equal(frames.length, count, "overflow cannot wrap into an old heartbeat sequence");
  } finally {
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument);
    else delete globalThis.document;
  }
});

test("body validation rejects stale-field shapes, scope widening, ambiguous ACKs and boundary overflow", () => {
  const example = (name) => structuredClone(RD.messages[name].examples[0]);
  const reject = (name, body) =>
    assert.throws(() => validateJsonBody(TYPES[name], body), /RD_PROTOCOL_MISMATCH/, name);
  reject("CONTROL_REQUEST", { ...example("CONTROL_REQUEST"), request_id: "not-a-uuid" });
  reject("CONTROL_REQUEST", {
    ...example("CONTROL_REQUEST"),
    requested_input_permissions: ["view"],
  });
  reject("CONTROL_REQUEST", {
    ...example("CONTROL_REQUEST"),
    requested_input_permissions: ["input.keyboard", "input.keyboard"],
  });
  reject("CONTROL_GRANTED", { ...example("CONTROL_GRANTED"), new_input_epoch: 0 });
  reject("CONTROL_GRANTED", { ...example("CONTROL_GRANTED"), new_input_epoch: 0x100000000 });
  reject("INPUT_SYNC_ACK", { ...example("INPUT_SYNC_ACK"), layout_epoch: 1.5 });
  reject("INPUT_STATE", { ...example("INPUT_STATE"), keys: [{ usage_page: 7, usage: 4 }] });
  reject("INPUT_STATE", { ...example("INPUT_STATE"), buttons: 1 });
  reject("INPUT_HEARTBEAT", {
    ...example("INPUT_HEARTBEAT"),
    keys: [
      { usage_page: 7, usage: 4 },
      { usage: 4, usage_page: 7 },
    ],
  });
  reject("INPUT_HEARTBEAT", { ...example("INPUT_HEARTBEAT"), buttons: 32 });
  reject("FEATURE_REQUEST", { ...example("FEATURE_REQUEST"), permission: "input.keyboard" });
  reject("FEATURE_STATE", { ...example("FEATURE_STATE"), enabled: "false" });
  reject("FEATURE_STATE", { ...example("FEATURE_STATE"), error_code: "unbounded user text" });
  reject("SESSION_READY", { ...example("SESSION_READY"), permissions: ["input.keyboard"] });
  reject("SESSION_HELLO", {
    ...example("SESSION_HELLO"),
    protocol: { major: 1, minor: 0, trusted: true },
  });
  reject("SESSION_HELLO", { ...example("SESSION_HELLO"), nonce: "A".repeat(42) + "B" });
  reject("SESSION_PROOF", { ...example("SESSION_PROOF"), signature: "A".repeat(85) + "B" });
  reject("PATH_VERIFIED", { ...example("PATH_VERIFIED"), local_candidate_type: "relay" });
  reject("PATH_VERIFIED", { ...example("PATH_VERIFIED"), protocol: "tcp" });
  reject("DISPLAY_SELECT", { display_id: "0", expected_layout_epoch: 1 });
  const layout = example("DISPLAY_LAYOUT");
  reject("DISPLAY_LAYOUT", { ...layout, active_display: "missing" });
  reject("DISPLAY_LAYOUT", {
    ...layout,
    displays: [layout.displays[0], { ...layout.displays[0], id: "other" }],
  });
  reject("DISPLAY_LAYOUT", { ...layout, displays: [{ ...layout.displays[0], width_px: 32769 }] });
  reject("DISPLAY_LAYOUT", {
    ...layout,
    displays: [{ ...layout.displays[0], native_handle: "private" }],
  });
  reject("CLIPBOARD_OFFER", { ...example("CLIPBOARD_OFFER"), size: 65537 });
  reject("CLIPBOARD_OFFER", { ...example("CLIPBOARD_OFFER"), mime: "text/html" });
  reject("CLIPBOARD_OFFER", { ...example("CLIPBOARD_OFFER"), sha256: "A".repeat(64) });
  reject("FILE_OFFER", { ...example("FILE_OFFER"), size: RD.limits.file_bytes + 1 });
  for (const name of [
    "../secret",
    "C:\\secret",
    "CON.txt",
    "report.",
    "report ",
    "bad\u0000.txt",
    ".",
    "..",
  ])
    reject("FILE_OFFER", { ...example("FILE_OFFER"), name });
  reject("FILE_ACK", { ...example("FILE_ACK"), sha256: "a".repeat(64) });
  reject("FILE_ACK", { ...example("FILE_ACK"), offset: -1 });
  assert.doesNotThrow(() =>
    validateJsonBody(TYPES.FILE_OFFER, { ...example("FILE_OFFER"), size: RD.limits.file_bytes }),
  );
  assert.doesNotThrow(() =>
    validateJsonBody(TYPES.CLIPBOARD_OFFER, { ...example("CLIPBOARD_OFFER"), size: 65536 }),
  );
});

test("frame decoder applies body schemas and rejects reserved messages before dispatch", () => {
  const body = RD.messages.SESSION_HELLO.examples[0];
  const frame = encodeFrame(TYPES.SESSION_HELLO, body, { epoch: 1, sequence: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(decodeFrame(frame, "control").payload)), body);
  assert.throws(
    () => encodeFrame(TYPES.SESSION_HELLO, { ...body, trusted: true }, { epoch: 1, sequence: 1 }),
    /RD_PROTOCOL_MISMATCH/,
  );
  assert.throws(
    () => encodeFrame(TYPES.STREAM_CONFIG, {}, { epoch: 1, sequence: 1 }),
    /RD_PROTOCOL_MISMATCH/,
  );
});

test("generated documentation and all nine binary layouts match the registry", async () => {
  const canonical = JSON.parse(
    await readFile(new URL("../../contracts/remote-desktop.v1.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(RD, canonical, "generated registry must match canonical schema");
  const generated = spawnSync(
    "python",
    [
      fileURLToPath(new URL("../../scripts/generate-remote-protocol.py", import.meta.url)),
      "--check",
    ],
    { encoding: "utf8" },
  );
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);
  const documentation = await readFile(
    new URL("../../contracts/REMOTE_PROTOCOL.md", import.meta.url),
    "utf8",
  );
  for (const [name, definition] of Object.entries(RD.messages)) {
    assert.ok(
      documentation.includes(
        `| ${name} | \`0x${definition.id.toString(16).padStart(2, "0")}\` / ${definition.channel} | ${definition.encoding} / ${definition.wire_status} |`,
      ),
      name,
    );
    assert.ok(
      definition.max_payload_bytes + RD.header.length <=
        RD.channels[definition.channel].max_message_bytes,
      name,
    );
    if (definition.encoding !== "binary") continue;
    const fields = definition.binary_layout.fields;
    assert.equal(fields[0].offset, 0, name);
    for (let index = 1; index < fields.length; index++)
      assert.equal(fields[index].offset, fields[index - 1].offset + fields[index - 1].bytes, name);
    if (definition.payload_bytes)
      assert.equal(fields.at(-1).offset + fields.at(-1).bytes, definition.payload_bytes, name);
  }
  assert.equal(RD.messages.FILE_CHUNK.max_payload_bytes, 24 + RD.limits.file_chunk_bytes);
  assert.equal(
    RD.messages.CLIPBOARD_CHUNK.max_payload_bytes,
    RD.channels.clipboard.max_message_bytes - RD.header.length,
  );
});

test("requesting input again releases old keys and control before creating a new request", () => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { hidden: false } });
  try {
    const session = Object.create(RemoteSession.prototype),
      frames = [];
    let cleared = 0;
    const previous = crypto.randomUUID();
    Object.assign(session, {
      ready: true,
      video: { videoWidth: 100 },
      inputEnabled: true,
      inputRequested: true,
      inputRequestId: previous,
      permissions: new Set(["view", "input.keyboard"]),
      closed: false,
      clearInputState: () => {
        cleared++;
      },
      send: (type, payload) => frames.push({ type, payload }),
    });
    session.requestInput();
    assert.equal(cleared, 1);
    assert.equal(session.inputEnabled, false);
    assert.equal(session.inputRequested, true);
    assert.notEqual(session.inputRequestId, previous);
    assert.deepEqual(
      frames.map((frame) => frame.type),
      [TYPES.RELEASE_ALL, TYPES.CONTROL_REQUEST],
    );
    assert.equal(frames[1].payload.request_id, session.inputRequestId);
    const pending = session.inputRequestId;
    session.requestInput();
    assert.equal(session.inputEnabled, false);
    assert.notEqual(session.inputRequestId, pending);
    assert.deepEqual(
      frames.slice(2).map((frame) => frame.type),
      [TYPES.RELEASE_ALL, TYPES.CONTROL_REQUEST],
    );
  } finally {
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument);
    else delete globalThis.document;
  }
});

test("released or previous input grants cannot enable input or terminate viewing", async () => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { hidden: false } });
  try {
    const session = Object.create(RemoteSession.prototype),
      sent = [];
    Object.assign(session, {
      lease: { valid: () => true },
      epoch: 1,
      received: new Map(),
      peerVerified: true,
      pathVerified: true,
      ready: true,
      inputRequested: false,
      inputEnabled: false,
      inputEpoch: 1,
      inputRequestId: null,
      layout: { layout_epoch: 1 },
      send: (type, payload) => sent.push({ type, payload }),
    });
    await session.onFrame(
      {
        type: TYPES.CONTROL_GRANTED,
        epoch: 1,
        sequence: 1,
        payload: { request_id: crypto.randomUUID(), new_input_epoch: 2 },
      },
      "control",
    );
    session.inputRequested = true;
    session.inputRequestId = crypto.randomUUID();
    await session.onFrame(
      {
        type: TYPES.INPUT_SYNC_ACK,
        epoch: 1,
        sequence: 2,
        payload: { request_id: crypto.randomUUID(), input_epoch: 1, layout_epoch: 1 },
      },
      "control",
    );
    assert.equal(session.ready, true);
    assert.equal(session.inputEnabled, false);
    assert.equal(sent.length, 2);
    assert.ok(sent.every((frame) => frame.type === TYPES.RELEASE_ALL));
  } finally {
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument);
    else delete globalThis.document;
  }
});

test("an old account response cannot resume endpoint enrollment after logout", async () => {
  let finish,
    calls = 0,
    current = true;
  const api = new RemoteApi(
    async () => {
      calls++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    "old-user",
    () => current,
  );
  const pending = api.initialize();
  current = false;
  api.close();
  finish({ server_instance_id: "old-instance" });
  await assert.rejects(pending, /RD_SESSION_REVOKED/);
  assert.equal(calls, 1);
  assert.equal(api.identity, undefined);
});

test("final file commit completing after cancellation does not ACK success", async (t) => {
  const progress = [],
    { transfers, frames } = transferHarness({ onProgress: (value) => progress.push(value) });
  t.after(() => transfers.close());
  const id = crypto.randomUUID();
  let finish;
  await transfers.onFrame({ type: TYPES.FILE_OFFER, payload: { id, name: "empty.txt", size: 0 } });
  await transfers.acceptFile(id, {
    write: async () => {},
    close: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    abort: async () => {},
  });
  const pending = transfers.onFrame({
    type: TYPES.FILE_COMPLETE,
    payload: { id, size: 0, sha256: createHash("sha256").digest("hex") },
  });
  assert.equal((await transfers.cancel(id)).mayBeSaved, true);
  finish();
  await pending;
  assert.equal(
    frames.some((frame) => frame.type === TYPES.FILE_ACK),
    false,
  );
  assert.equal(
    progress.some((value) => value.complete),
    false,
  );
  await transfers.onFrame({ type: TYPES.FILE_CHUNK, payload: chunk(id, 0, Uint8Array.of(1)) });
});

test("host-signed grant and server authorizations bind the original one-session request", async (t) => {
  const fixture = JSON.parse(
    await readFile(
      new URL("../../contracts/remote-authorization-vectors.json", import.meta.url),
      "utf8",
    ),
  );
  const binding = fixture.expected_binding,
    oldLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  t.mock.method(Date, "now", () => fixture.reference_time_unix * 1000);
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: binding.iss },
  });
  try {
    const session = new RemoteSession({
      api: {
        userId: binding.owner_user_id,
        keys: fixture.keyset,
        identity: { endpointId: binding.controller_endpoint_id, jkt: binding.controller_jkt },
      },
      signal: {},
      session: {
        ...binding,
        host_public_jwk: fixture.identities.host.public_jwk,
        ticket_jws: fixture.valid.ticket.jws_parts.join("."),
        lease_jws: fixture.valid.lease.jws_parts.join("."),
        grant_jws: fixture.valid.grant.jws_parts.join("."),
      },
      hostThumbprint: binding.host_jkt,
      video: {},
    });
    await session.authorize();
    assert.equal(session.lease.valid(), true);
    for (const rejected of fixture.rejected) {
      await assert.rejects(
        session.serverClaims(
          rejected.jws_parts.join("."),
          rejected.kind === "ticket" ? "ht-rd-ticket+jwt" : "ht-rd-lease+jwt",
          rejected.kind === "ticket" ? "ht-rd-start" : "ht-rd-use",
        ),
        rejected.name,
      );
    }
  } finally {
    if (oldLocation) Object.defineProperty(globalThis, "location", oldLocation);
    else delete globalThis.location;
  }
});

test("HTTP response limits cancel oversized streams before accumulating the body", async () => {
  let canceled = false;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(32));
      },
      cancel() {
        canceled = true;
      },
    }),
  );
  await assert.rejects(boundedResponse(response, 64), /RD_MESSAGE_TOO_LARGE/);
  assert.equal(canceled, true);
  await assert.rejects(boundedResponse(new Response(Uint8Array.of(0xc0, 0xaf))));
  assert.equal((await boundedResponse(new Response('{"value":"中文"}'))).value, "中文");
});

test("stopping a microphone invalidates capture permission still in flight", async () => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document"),
    oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let grantCapture,
    stopped = 0;
  const replaced = [];
  const track = {
      stop() {
        stopped++;
      },
    },
    stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  Object.defineProperty(globalThis, "document", { configurable: true, value: { hidden: false } });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: () =>
          new Promise((resolve) => {
            grantCapture = resolve;
          }),
      },
    },
  });
  try {
    const session = Object.create(RemoteSession.prototype);
    Object.assign(session, {
      ready: true,
      permissions: new Set(["audio.microphone"]),
      featureState: new Set(),
      featureRequests: new Map(),
      lease: { valid: () => true },
      microphoneTransceiver: {
        sender: {
          replaceTrack: async (value) => {
            replaced.push(value);
          },
        },
      },
      setFeature: async (permission, enabled) => {
        if (enabled) session.featureState.add(permission);
        else session.featureState.delete(permission);
      },
    });
    const pending = session.startMicrophone();
    await new Promise((resolve) => setImmediate(resolve));
    await session.stopMicrophone();
    grantCapture(stream);
    await assert.rejects(pending, /RD_SESSION_REVOKED/);
    assert.equal(stopped, 1);
    assert.equal(replaced.includes(track), false);
    assert.equal(session.microphone, null);
  } finally {
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument);
    else delete globalThis.document;
    if (oldNavigator) Object.defineProperty(globalThis, "navigator", oldNavigator);
    else delete globalThis.navigator;
  }
});

test("the public key message and proof transcript match the cross-language vectors", async () => {
  const frame = decodeFrame(Buffer.from(vectors.key_down_a.wire_hex, "hex"), "input");
  assert.equal(frame.type, TYPES.KEY);
  assert.equal(frame.epoch, 3);
  assert.equal(frame.inputEpoch, 7);
  assert.equal(
    hex(encodeFrame(TYPES.KEY, frame.payload, { epoch: 3, inputEpoch: 7, sequence: 1 })),
    vectors.key_down_a.wire_hex,
  );
  const proof = vectors.proof;
  const value = proofTranscript({
    sessionId: proof.session_id,
    epoch: proof.connection_epoch,
    controllerNonce: Buffer.from(proof.controller_nonce, "hex"),
    hostNonce: Buffer.from(proof.host_nonce, "hex"),
    offerHash: Buffer.from(proof.offer_jws_sha256, "hex"),
    answerHash: Buffer.from(proof.answer_jws_sha256, "hex"),
    ticketHash: Buffer.from(proof.ticket_sha256, "hex"),
  });
  assert.equal(hex(value), proof.transcript_hex);
  assert.equal(hex(await sha256(value)), proof.sha256);
  const key = await crypto.subtle.importKey(
    "jwk",
    proof.public_jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  assert.equal(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      Buffer.from(proof.signature_raw64_hex, "hex"),
      value,
    ),
    true,
  );
});

test("streaming SHA256 matches Node across padding boundaries, sliced buffers and chunk sizes", () => {
  for (const length of [0, 1, 55, 56, 63, 64, 65, 127, 128, 129, 16384, 65537, 1000000]) {
    const data = randomBytes(length + 17).subarray(17),
      expected = createHash("sha256").update(data).digest("hex");
    for (const chunk of [1, 7, 64, 8192, 16384]) {
      const hash = new Sha256Stream();
      for (let offset = 0; offset < length; offset += chunk)
        hash.update(data.subarray(offset, offset + chunk));
      assert.equal(hash.digest(), expected, `${length}/${chunk}`);
      assert.equal(hash.digest(), expected);
      assert.throws(() => hash.update(new Uint8Array()));
    }
  }
});

test("leases use a monotonic deadline, refuse stale renewal and cannot revive after expiry", () => {
  let elapsed = 0;
  const lease = new LeaseDeadline(() => elapsed),
    claims = { iat: 1000, exp: 1010, lease_seq: 1 };
  lease.update(claims, 1000000);
  elapsed = 9999;
  assert.equal(lease.valid(), true);
  assert.throws(() => lease.update(claims, 1000000));
  elapsed = 10000;
  assert.equal(lease.valid(), false);
  assert.throws(() => lease.update({ iat: 1000, exp: 1020, lease_seq: 2 }, 1000000));
  assert.throws(() => new LeaseDeadline().update({ iat: 1000, exp: 2000, lease_seq: 1 }, 1000000));
});

test("candidate replay window allows limited reordering and rejects replay, gaps and uint64 overflow", () => {
  const replay = new PeerReplayWindow();
  replay.accept("2", true);
  replay.accept("1", true);
  assert.throws(() => replay.accept("1", true));
  replay.accept("40", true);
  assert.throws(() => replay.accept("8", true));
  replay.accept("9", true);
  assert.throws(() => replay.accept("39"));
  assert.throws(() => replay.accept("18446744073709551616", true));
});

test("selected candidate pair rejects TCP and relay while exposing incomplete browser diagnostics", () => {
  const stats = new Map([
    ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
    [
      "pair",
      {
        type: "candidate-pair",
        id: "pair",
        localCandidateId: "local",
        remoteCandidateId: "remote",
      },
    ],
    ["local", { protocol: "udp", candidateType: "host" }],
    ["remote", { protocol: "udp", candidateType: "srflx" }],
  ]);
  assert.deepEqual(selectedUdpPair(stats), { id: "pair", verified: true });
  stats.get("remote").candidateType = "relay";
  assert.throws(() => selectedUdpPair(stats));
  stats.get("remote").candidateType = "host";
  stats.get("local").protocol = "tcp";
  assert.throws(() => selectedUdpPair(stats));
  stats.delete("local");
  assert.equal(selectedUdpPair(stats).verified, false);
  assert.equal(selectedUdpPair(new Map()), null);
});

test("pointer mapping ignores letterboxes and HID identities do not depend on keyboard language", () => {
  const rect = { left: 10, top: 10, width: 400, height: 400 };
  assert.equal(pointerCoordinates(rect, 1920, 1080, 20, 20), null);
  const point = pointerCoordinates(rect, 1920, 1080, 210, 210);
  assert.ok(Math.abs(point.x - 32768) < 40 && Math.abs(point.y - 32768) < 40);
  assert.equal(pointerCoordinates(rect, 0, 1080, 200, 200), null);
  assert.equal(keyUsage("KeyA"), 4);
  assert.equal(keyUsage("ControlRight"), 228);
});

function transferHarness(options = {}) {
  const frames = [],
    channel = new EventTarget();
  channel.readyState = "open";
  channel.bufferedAmount = 0;
  const session = {
    ready: true,
    lease: { valid: () => true },
    featureState: new Set(["files.send", "files.receive", "clipboard.read", "clipboard.write"]),
    channels: new Map([
      ["file", channel],
      ["clipboard", channel],
    ]),
    send: (type, payload) => frames.push({ type, payload }),
  };
  const transfers = new RemoteTransfers(session, { canUseClipboard: () => true, ...options });
  return { frames, session, transfers, channel };
}
function chunk(id, offset, data) {
  const body = new Uint8Array(data.length + 24);
  body.set(Buffer.from(id.replaceAll("-", ""), "hex"));
  new DataView(body.buffer).setBigUint64(16, BigInt(offset));
  body.set(data, 24);
  return body;
}
const immediate = () => new Promise((resolve) => setImmediate(resolve));

test("file receive requires destination acceptance, serialized writes, exact offsets and final integrity", async (t) => {
  const { transfers, frames } = transferHarness();
  t.after(() => transfers.close());
  const id = crypto.randomUUID(),
    data = Buffer.from("中文文件\u0000binary"),
    writes = [];
  let closed = false,
    aborted = false;
  await transfers.onFrame({
    type: TYPES.FILE_OFFER,
    payload: { id, name: "测试.bin", size: data.length },
  });
  await assert.rejects(transfers.onFrame({ type: TYPES.FILE_CHUNK, payload: chunk(id, 0, data) }));
  await transfers.acceptFile(id, {
    write: async (value) => writes.push(Buffer.from(value)),
    close: async () => {
      closed = true;
    },
    abort: async () => {
      aborted = true;
    },
  });
  await assert.rejects(transfers.onFrame({ type: TYPES.FILE_CHUNK, payload: chunk(id, 1, data) }));
  await transfers.onFrame({ type: TYPES.FILE_CHUNK, payload: chunk(id, 0, data) });
  assert.deepEqual(frames.at(-1), { type: TYPES.FILE_ACK, payload: { id, offset: data.length } });
  assert.equal(closed, false);
  const digest = createHash("sha256").update(data).digest("hex");
  await transfers.onFrame({
    type: TYPES.FILE_COMPLETE,
    payload: { id, size: data.length, sha256: digest },
  });
  assert.deepEqual(Buffer.concat(writes), data);
  assert.equal(closed, true);
  assert.equal(aborted, false);
  assert.deepEqual(frames.at(-1), { type: TYPES.FILE_ACK, payload: { id, sha256: digest } });
});

test("corrupt or interrupted files abort the destination and never report success", async (t) => {
  const { transfers } = transferHarness();
  t.after(() => transfers.close());
  let aborts = 0;
  for (const corrupt of [true, false]) {
    const id = crypto.randomUUID();
    await transfers.onFrame({ type: TYPES.FILE_OFFER, payload: { id, name: "data.bin", size: 1 } });
    await transfers.acceptFile(id, {
      write: async () => {},
      close: async () => assert.fail("must not commit"),
      abort: async () => {
        aborts++;
      },
    });
    await transfers.onFrame({ type: TYPES.FILE_CHUNK, payload: chunk(id, 0, Uint8Array.of(1)) });
    if (corrupt)
      await assert.rejects(
        transfers.onFrame({
          type: TYPES.FILE_COMPLETE,
          payload: { id, size: 1, sha256: "0".repeat(64) },
        }),
      );
    else await transfers.revoke("files.receive");
  }
  assert.equal(aborts, 2);
  for (const name of ["../secret", "C:secret", "CON", "aux.txt", "trailing.", "bad\u0000name"])
    assert.throws(() => safeFilename(name));
});

test("sender waits for disk acknowledgement before reading the next chunk and cancels promptly", async (t) => {
  const { transfers, frames } = transferHarness();
  t.after(() => transfers.close());
  const content = randomBytes(32769),
    blob = new Blob([content]);
  blob.name = "content.bin";
  await transfers.offerFiles([blob]);
  const id = frames[0].payload.id;
  await transfers.onFrame({ type: TYPES.FILE_ACCEPT, payload: { id } });
  await immediate();
  await immediate();
  assert.equal(frames.filter((frame) => frame.type === TYPES.FILE_CHUNK).length, 1);
  await transfers.onFrame({ type: TYPES.FILE_ACK, payload: { id, offset: 16384 } });
  await immediate();
  await immediate();
  assert.equal(frames.filter((frame) => frame.type === TYPES.FILE_CHUNK).length, 2);
  await transfers.cancel(id);
  await immediate();
  assert.equal(frames.filter((frame) => frame.type === TYPES.FILE_COMPLETE).length, 0);
  assert.equal(transfers.outgoing.size, 0);
});

test("clipboard is opt-in, UTF8 bounded, verified, deduplicated and cleared on revoke", async (t) => {
  const received = [],
    { transfers, session } = transferHarness({ onClipboard: (text) => received.push(text) });
  t.after(() => transfers.close());
  const data = Buffer.from("你好\nworld"),
    digest = createHash("sha256").update(data).digest("hex");
  for (let index = 0; index < 2; index++) {
    const id = crypto.randomUUID();
    await transfers.onFrame({
      type: TYPES.CLIPBOARD_OFFER,
      payload: { id, mime: "text/plain;charset=utf-8", size: data.length, sha256: digest },
    });
    await transfers.onFrame({ type: TYPES.CLIPBOARD_CHUNK, payload: chunk(id, 0, data) });
  }
  assert.deepEqual(received, [data.toString()]);
  await assert.rejects(transfers.sendClipboard("a".repeat(65537)));
  await transfers.sendClipboard("local content");
  const sensitive = transfers.clipboardOutgoing.content;
  await transfers.revoke("clipboard.write");
  assert.ok(sensitive.every((value) => value === 0));
  session.featureState.delete("clipboard.write");
  await assert.rejects(transfers.sendClipboard("blocked"));
});

test("a blocked file write does not delay control-channel revocation", async () => {
  let release,
    control = false;
  const session = Object.create(RemoteSession.prototype);
  Object.assign(session, {
    pendingBytes: 0,
    pendingCount: 0,
    frameQueues: new Map(),
    closed: false,
    onFrame: async (_frame, channel) => {
      if (channel === "file")
        await new Promise((resolve) => {
          release = resolve;
        });
      else control = true;
    },
    fail: (error) => {
      throw error;
    },
  });
  session.enqueueFrame(
    encodeFrame(
      TYPES.FILE_OFFER,
      { id: crypto.randomUUID(), name: "x", size: 0 },
      { epoch: 1, sequence: 1 },
    ),
    "file",
  );
  session.enqueueFrame(encodeFrame(TYPES.SESSION_CLOSE, {}, { epoch: 1, sequence: 1 }), "control");
  await immediate();
  assert.equal(control, true);
  release();
  await Promise.all(session.frameQueues.values());
  assert.equal(session.pendingBytes, 0);
});

test("keyset rotations follow public cross-platform signed fixtures and preserve origin trust", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("../test-fixtures/rd-keyset-vectors.json", import.meta.url), "utf8"),
  );
  const now = Date.parse(fixture.now) / 1000,
    envelope = (set) => ({ ...set, restore_epoch: 1 });
  const initial = await verifyServerKeyset(null, envelope(fixture.initial), now);
  const rotated = await verifyServerKeyset(initial, envelope(fixture.rotated), now);
  assert.equal(rotated.keyset_version, 2);
  assert.equal(
    (await verifyServerKeyset(initial, envelope(fixture.rotated_twice), now)).keyset_version,
    3,
  );
  await assert.rejects(verifyServerKeyset(rotated, envelope(fixture.initial), now));
  await assert.rejects(
    verifyServerKeyset(initial, { ...envelope(fixture.rotated), rotation_proofs: [] }, now),
  );
  await assert.rejects(
    verifyServerKeyset(
      initial,
      { ...envelope(fixture.initial), server_instance_id: "different-server" },
      now,
    ),
  );
  await assert.rejects(
    verifyServerKeyset(initial, { ...envelope(fixture.rotated), keyset_version: 1 }, now),
  );
  await assert.rejects(
    verifyServerKeyset({ ...initial, restore_epoch: 2 }, envelope(fixture.initial), now),
  );
  await assert.rejects(
    verifyServerKeyset(initial, envelope(fixture.initial), now + 10 * 365 * 86400),
  );
});

test("reject malformed length, type, channel, flags, version and input generation", () => {
  const wire = Buffer.from(vectors.key_down_a.wire_hex, "hex");
  for (const [offset, value] of [
    [0, 0],
    [2, 2],
    [3, 255],
    [4, 1],
    [7, 25],
    [23, 9],
    [15, 0],
  ]) {
    const changed = Buffer.from(wire);
    changed[offset] = value;
    assert.throws(() => decodeFrame(changed, "input"));
  }
  assert.throws(() => decodeFrame(wire, "motion"));
  assert.throws(() => decodeFrame(wire.subarray(0, 20), "input"));
  assert.throws(() =>
    encodeFrame(TYPES.SESSION_CLOSE, {}, { epoch: 1, sequence: RD.limits.sequence_reconnect_at }),
  );
  assert.throws(() =>
    encodeFrame(TYPES.KEY, wire.subarray(24), { epoch: 1, inputEpoch: 1, sequence: -1 }),
  );
  assert.throws(() =>
    encodeFrame(TYPES.SESSION_CLOSE, {}, { epoch: 1, inputEpoch: 1, sequence: 1 }),
  );
});

test("strict JSON refuses duplicate decoded keys and malformed/unbounded claims", () => {
  for (const text of [
    '{"alg":"ES256","alg":"none"}',
    '{"jti":1,"\\u006ati":2}',
    '{"a":{"x":1,"x":2}}',
    '{"x":1,}',
    "[1,]",
    '{"x":1e999}',
    '{"x":01}',
    "true false",
    '"bad\nstring"',
    "[".repeat(30) + "0" + "]".repeat(30),
  ]) {
    assert.throws(() => strictJson(text), text);
  }
  assert.equal(strictJson('{"a":[true,null,-2.5],"__proto__":{"polluted":1}}').a[2], -2.5);
  assert.equal({}.polluted, undefined);
  assert.throws(() => strictJson('"' + "x".repeat(20) + '"', 10));
});

test("only direct UDP candidates survive, including IPv6 and mDNS", () => {
  for (const address of ["192.168.1.4", "2001:db8::1", "host-123.local"]) {
    assert.match(
      directCandidate(`candidate:1 1 udp 2122260223 ${address} 49152 typ host`),
      /typ host$/,
    );
  }
  for (const line of [
    "candidate:1 1 tcp 1 192.168.1.4 9 typ host tcptype active",
    "candidate:1 1 udp 1 192.168.1.4 49152 typ relay",
    "candidate:1 1 udp 1 192.168.1.4 0 typ srflx",
  ])
    assert.throws(() => directCandidate(line));
  assert.throws(() => validateSdp("v=0\r\nm=application 9 TCP/DTLS/SCTP webrtc-datachannel\r\n"));
  assert.doesNotThrow(() => validateSdp("v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n"));
});

test("ES256 uses raw signatures and pins type, algorithm, public key and key id", async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ]);
  const jwk = publicJwk(await crypto.subtle.exportKey("jwk", pair.publicKey));
  const identity = { privateKey: pair.privateKey, jwk };
  const signed = await signJws(identity, { nonce: "fixture-only", epoch: 1 });
  const verified = await verifyJws(signed, jwk, "ht-rd-proof+jwt");
  assert.equal(verified.nonce, "fixture-only");
  assert.equal(unbase64url(signed.split(".")[2]).length, 64);
  assert.equal((await thumbprint(jwk)).length, 43);
  await assert.rejects(verifyJws(signed, jwk, "ht-rd-ticket+jwt"));
  await assert.rejects(verifyJws(signed, jwk, "ht-rd-proof+jwt", { kid: "unexpected" }));
  const parts = signed.split(".");
  parts[1] = base64url(new TextEncoder().encode('{"nonce":"changed","epoch":1}'));
  await assert.rejects(verifyJws(parts.join("."), jwk, "ht-rd-proof+jwt"));
  assert.throws(() => publicJwk({ ...jwk, d: "private" }));
  assert.throws(() => unbase64url("AB"));
});
