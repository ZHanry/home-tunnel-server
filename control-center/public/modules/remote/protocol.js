import { RD, TYPES } from "./protocol.generated.js";

export { RD, TYPES };
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const definitions = new Map(Object.values(RD.messages).map((value) => [value.id, value]));

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("RD_INVALID_JSON");
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error("RD_INVALID_JSON");
  return result;
}

export function bytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new Error("RD_PROTOCOL_MISMATCH");
}

// JSON.parse discards duplicate security fields. Reject them before constructing claims.
export function strictJson(text, maximum = 16384) {
  if (typeof text !== "string" || encoder.encode(text).length > maximum) throw new Error("RD_MESSAGE_TOO_LARGE");
  let cursor = 0;
  const whitespace = () => { while (/[\t\n\r ]/.test(text[cursor] ?? "x")) cursor++; };
  function string() {
    const start = cursor++;
    while (cursor < text.length) {
      const char = text[cursor++];
      if (char === "\\") { cursor++; continue; }
      if (char === '"') return JSON.parse(text.slice(start, cursor));
    }
    throw new Error("RD_INVALID_JSON");
  }
  function value(depth) {
    if (depth > 24) throw new Error("RD_INVALID_JSON");
    whitespace();
    if (text[cursor] === '"') return string();
    if (text[cursor] === "{") {
      cursor++;
      const result = Object.create(null), keys = new Set();
      whitespace();
      if (text[cursor] === "}") { cursor++; return result; }
      while (cursor < text.length) {
        whitespace();
        if (text[cursor] !== '"') throw new Error("RD_INVALID_JSON");
        const key = string();
        if (keys.has(key)) throw new Error("RD_DUPLICATE_JSON_KEY");
        keys.add(key);
        whitespace();
        if (text[cursor++] !== ":") throw new Error("RD_INVALID_JSON");
        result[key] = value(depth + 1);
        whitespace();
        const next = text[cursor++];
        if (next === "}") return result;
        if (next !== ",") throw new Error("RD_INVALID_JSON");
      }
    } else if (text[cursor] === "[") {
      cursor++;
      const result = [];
      whitespace();
      if (text[cursor] === "]") { cursor++; return result; }
      while (cursor < text.length && result.length < 4096) {
        result.push(value(depth + 1));
        whitespace();
        const next = text[cursor++];
        if (next === "]") return result;
        if (next !== ",") throw new Error("RD_INVALID_JSON");
      }
    } else {
      const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(cursor));
      if (match) {
        cursor += match[0].length;
        const result = JSON.parse(match[0]);
        if (typeof result === "number" && (!Number.isFinite(result) || (Number.isInteger(result) && !Number.isSafeInteger(result)))) throw new Error("RD_INVALID_JSON");
        return result;
      }
    }
    throw new Error("RD_INVALID_JSON");
  }
  const result = value(0);
  whitespace();
  if (cursor !== text.length) throw new Error("RD_INVALID_JSON");
  return result;
}

function uint32(value, allowZero = true) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > 0xffffffff) throw new Error("RD_PROTOCOL_MISMATCH");
  return value;
}

export function encodeFrame(type, payload, { epoch, inputEpoch = 0, sequence, flags = 0 }) {
  const definition = definitions.get(type);
  if (!definition) throw new Error("RD_PROTOCOL_MISMATCH");
  const content = definition.encoding === "json" ? encoder.encode(JSON.stringify(payload)) : bytes(payload);
  const output = new Uint8Array(RD.header.length + content.length), view = new DataView(output.buffer);
  view.setUint16(0, RD.header.magic); view.setUint8(2, RD.protocol.major); view.setUint8(3, type);
  if (!Number.isInteger(flags) || flags < 0 || flags > 65535 || (flags & ~(definition.allowed_flags ?? 0))) throw new Error("RD_PROTOCOL_MISMATCH");
  view.setUint16(4, flags); view.setUint16(6, RD.header.length);
  view.setUint32(8, uint32(epoch, false)); view.setUint32(12, uint32(inputEpoch));
  if (uint32(sequence, false) >= RD.limits.sequence_reconnect_at) throw new Error("RD_RECONNECT_REQUIRED");
  view.setUint32(16, sequence); view.setUint32(20, content.length); output.set(content, RD.header.length);
  decodeFrame(output, definition.channel);
  return output;
}

export function decodeFrame(input, channel) {
  const content = bytes(input);
  if (!RD.channels[channel] || content.byteLength < 24 || content.byteLength > RD.channels[channel].max_message_bytes) throw new Error("RD_MESSAGE_TOO_LARGE");
  const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
  const definition = definitions.get(view.getUint8(3));
  if (view.getUint16(0) !== RD.header.magic || view.getUint8(2) !== 1 || view.getUint16(6) !== 24 || !definition || definition.channel !== channel) throw new Error("RD_PROTOCOL_MISMATCH");
  if ((view.getUint16(4) & ~(definition.allowed_flags ?? 0)) || view.getUint32(20) !== content.length - 24 || (definition.payload_bytes !== undefined && definition.payload_bytes !== content.length - 24)) throw new Error("RD_PROTOCOL_MISMATCH");
  const epoch = view.getUint32(8), inputEpoch = view.getUint32(12), sequence = view.getUint32(16);
  if (!epoch || !sequence || sequence >= RD.limits.sequence_reconnect_at) throw new Error("RD_PROTOCOL_MISMATCH");
  if ((channel === "input" || channel === "motion") ? inputEpoch === 0 : inputEpoch !== 0) throw new Error("RD_PROTOCOL_MISMATCH");
  const body = content.subarray(24);
  const payload = definition.encoding === "json" ? strictJson(decoder.decode(body), RD.channels[channel].max_message_bytes) : body;
  if (definition.encoding === "json" && (!payload || typeof payload !== "object" || Array.isArray(payload))) throw new Error("RD_PROTOCOL_MISMATCH");
  return { type: view.getUint8(3), flags: view.getUint16(4), epoch, inputEpoch, sequence, payload };
}

export function directCandidate(candidate) {
  if (typeof candidate !== "string" || /[\r\n]/.test(candidate) || encoder.encode(candidate).length > 1024) throw new Error("RD_PATH_REJECTED");
  const fields = candidate.replace(/^a=/, "").trim().split(/\s+/);
  if (!/^candidate:[a-zA-Z0-9+/]{1,32}$/.test(fields[0]) || !/^[12]$/.test(fields[1]) || fields[2]?.toLowerCase() !== "udp" || !/^\d+$/.test(fields[3]) || Number(fields[3]) > 0xffffffff || !fields[4] || !/^\d+$/.test(fields[5]) || Number(fields[5]) < 1 || Number(fields[5]) > 65535 || fields[6] !== "typ" || !["host", "srflx", "prflx"].includes(fields[7])) throw new Error("RD_PATH_REJECTED");
  const address = fields[4];
  if (address.includes(":")) {
    try { if (!/^[0-9a-f:.]+$/i.test(address)) throw new Error(); new URL(`http://[${address}]/`); }
    catch { throw new Error("RD_PATH_REJECTED"); }
  } else if (/^[0-9.]+$/.test(address)) {
    if (address.split(".").length !== 4 || address.split(".").some((part) => !/^(0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255)) throw new Error("RD_PATH_REJECTED");
  } else if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+local$/i.test(address)) throw new Error("RD_PATH_REJECTED");
  if ((fields.length - 8) % 2 || fields.slice(8).includes("tcptype")) throw new Error("RD_PATH_REJECTED");
  return candidate;
}

export function validateSdp(sdp) {
  if (typeof sdp !== "string" || encoder.encode(sdp).length > 24576 || sdp.includes(String.fromCharCode(0))) throw new Error("RD_PROTOCOL_MISMATCH");
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith("a=candidate:")) directCandidate(line);
    if (line.startsWith("m=")) {
      const transport = line.trim().split(/\s+/)[2];
      if (!["UDP/TLS/RTP/SAVPF", "UDP/DTLS/SCTP"].includes(transport)) throw new Error("RD_PATH_REJECTED");
    }
  }
  return sdp;
}

export function uuidBytes(uuid) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) throw new Error("RD_PROTOCOL_MISMATCH");
  return Uint8Array.from(uuid.replaceAll("-", "").match(/../g), (part) => parseInt(part, 16));
}

export function proofTranscript({ sessionId, epoch, controllerNonce, hostNonce, offerHash, answerHash, ticketHash }) {
  const prefix = (value) => {
    const output = new Uint8Array(value.length + 4);
    new DataView(output.buffer).setUint32(0, value.length); output.set(value, 4); return output;
  };
  const counter = new Uint8Array(4); new DataView(counter.buffer).setUint32(0, uint32(epoch, false));
  const parts = [prefix(encoder.encode("ht-rd-proof-v1")), prefix(uuidBytes(sessionId)), counter];
  for (const value of [controllerNonce, hostNonce, offerHash, answerHash, ticketHash]) {
    const content = bytes(value);
    if (content.length !== 32) throw new Error("RD_PROOF_INVALID");
    parts.push(prefix(content));
  }
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0; for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}
