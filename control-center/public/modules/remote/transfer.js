import { RD, TYPES, uuidBytes } from "./protocol.js";
import { sha256 } from "./identity.js";
import { Sha256Stream } from "./sha256-stream.js";

const textEncoder = new TextEncoder(), textDecoder = new TextDecoder("utf-8", { fatal: true });
const hex = (input) => Array.from(input, (n) => n.toString(16).padStart(2, "0")).join("");
const uuid = (input) => { const h = hex(input); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`; };
export function safeFilename(name) {
  if (typeof name !== "string" || !name || name.length > 255 || name === "." || name === ".." || /[/\\:<>"|?*]/.test(name) || [...name].some((character) => character.codePointAt(0) < 32) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error("RD_FILE_NAME_INVALID");
  return name;
}
function size(value, maximum) { if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error("RD_FILE_TOO_LARGE"); return value; }

export class RemoteTransfers {
  constructor(session, { onOffer, onProgress, onClipboard, canUseClipboard = () => !document.hidden, timeoutMs = 30000 } = {}) {
    this.session = session; this.onOffer = onOffer; this.onProgress = onProgress; this.onClipboard = onClipboard;
    this.outgoing = new Map(); this.incoming = new Map(); this.clipboard = null; this.seen = new Set(); this.closed = false;
    this.canUseClipboard = canUseClipboard; this.timeoutMs = timeoutMs; this.waiters = new Set();
  }
  allowed(permission) { return !this.closed && this.session.ready && this.session.lease.valid() && this.session.featureState.has(permission) && (!permission.startsWith("clipboard.") || this.canUseClipboard()); }
  expire(id, item, collection) {
    clearTimeout(item.timer);
    item.timer = setTimeout(() => {
      if (collection.get(id) !== item) return;
      void this.cancel(id).catch(() => {}); this.onProgress?.({ id, error: "RD_FILE_TIMEOUT" });
    }, this.timeoutMs);
  }
  async room(channelName) {
    const channel = this.session.channels.get(channelName);
    if (!channel || channel.readyState !== "open" || this.closed) throw new Error("RD_MEDIA_FAILED");
    if (channel.bufferedAmount <= 65536) return;
    channel.bufferedAmountLowThreshold = 32768;
    await new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.waiters.delete(closed); channel.removeEventListener("bufferedamountlow", low); channel.removeEventListener("close", closed); };
      const low = () => { cleanup(); resolve(); }, closed = () => { cleanup(); reject(new Error("RD_MEDIA_FAILED")); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("RD_MEDIA_BACKPRESSURE")); }, 10000);
      this.waiters.add(closed);
      channel.addEventListener("bufferedamountlow", low, { once: true }); channel.addEventListener("close", closed, { once: true });
      if (channel.readyState !== "open" || this.closed) closed(); else if (channel.bufferedAmount <= 65536) low();
    });
  }
  async offerFiles(files) {
    if (!this.allowed("files.send")) throw new Error("RD_SCOPE_DENIED");
    if (!files.length || files.length > RD.limits.batch_files || this.outgoing.size + files.length > RD.limits.batch_files) throw new Error("RD_FILE_LIMIT");
    let total = [...this.outgoing.values()].reduce((sum, item) => sum + item.file.size, 0);
    for (const file of files) { safeFilename(file.name); total += size(file.size, RD.limits.file_bytes); }
    size(total, RD.limits.batch_file_bytes);
    for (const file of files) {
      if (!this.allowed("files.send")) throw new Error("RD_SCOPE_DENIED");
      const id = crypto.randomUUID(), item = { file, running: false, canceled: false };
      this.outgoing.set(id, item); this.expire(id, item, this.outgoing);
      try { await this.room("file"); this.session.send(TYPES.FILE_OFFER, { id, name: file.name, size: file.size }); }
      catch (error) { await this.cancel(id, false); throw error; }
      this.onProgress?.({ id, name: file.name, size: file.size, offered: true });
    }
  }
  async acceptFile(id, sink) {
    const item = this.incoming.get(id);
    if (!this.allowed("files.receive") || !item || item.sink || [...this.incoming.values()].filter((value) => value.sink).length >= 2) throw new Error("RD_FILE_LIMIT");
    if (!sink || !["write", "close", "abort"].every((method) => typeof sink[method] === "function")) throw new Error("RD_FILE_INVALID");
    item.sink = sink; item.hash = new Sha256Stream(); item.offset = 0;
    this.expire(id, item, this.incoming);
    try { this.session.send(TYPES.FILE_ACCEPT, { id }); } catch (error) { await this.cancel(id, false); throw error; }
  }
  async sendFile(id, item) {
    if (!this.allowed("files.send") || item.running || [...this.outgoing.values()].filter((value) => value.running).length >= 2) throw new Error("RD_FILE_LIMIT");
    item.running = true; item.hash = new Sha256Stream(); clearTimeout(item.timer);
    try {
      for (let offset = 0; offset < item.file.size; offset += RD.limits.file_chunk_bytes) {
        if (item.canceled || !this.allowed("files.send")) throw new Error("RD_FILE_CANCELLED");
        await this.room("file");
        const content = new Uint8Array(await item.file.slice(offset, offset + RD.limits.file_chunk_bytes).arrayBuffer());
        if (item.canceled || !this.allowed("files.send") || content.length !== Math.min(RD.limits.file_chunk_bytes, item.file.size - offset)) throw new Error("RD_FILE_CANCELLED");
        const payload = new Uint8Array(content.length + 24); payload.set(uuidBytes(id)); new DataView(payload.buffer).setBigUint64(16, BigInt(offset)); payload.set(content, 24);
        item.hash.update(content);
        // At most one unacknowledged chunk per file. SCTP buffering alone cannot
        // bound a receiver's pending disk writes or detect a failed destination.
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { item.ack = null; reject(new Error("RD_FILE_TIMEOUT")); }, this.timeoutMs);
          item.ack = { offset: offset + content.length, resolve: () => { clearTimeout(timer); resolve(); }, reject: (error) => { clearTimeout(timer); reject(error); } };
          try { this.session.send(TYPES.FILE_CHUNK, payload); }
          catch (error) { item.ack.reject(error); item.ack = null; }
        });
        this.onProgress?.({ id, sent: offset + content.length, size: item.file.size });
      }
      await this.room("file");
      if (item.canceled || !this.allowed("files.send")) throw new Error("RD_FILE_CANCELLED");
      item.digest = item.hash.digest(); this.session.send(TYPES.FILE_COMPLETE, { id, size: item.file.size, sha256: item.digest }); this.expire(id, item, this.outgoing);
    } catch (error) { await this.cancel(id).catch(() => {}); this.onProgress?.({ id, error: error.message }); }
    finally { item.running = false; }
  }
  async sendClipboard(text) {
    if (!this.allowed("clipboard.write") || typeof text !== "string" || !text.isWellFormed()) throw new Error("RD_SCOPE_DENIED");
    const content = textEncoder.encode(text);
    size(content.length, RD.limits.clipboard_bytes);
    const id = crypto.randomUUID(), digest = hex(await sha256(content));
    if (!this.allowed("clipboard.write")) { content.fill(0); throw new Error("RD_SCOPE_DENIED"); }
    if (this.lastClipboardDigest === digest) return;
    if (this.clipboardOutgoing) throw new Error("RD_CLIPBOARD_BUSY");
    this.clipboardOutgoing = { id, content, digest };
    this.clipboardOutgoing.timer = setTimeout(() => this.clearClipboard(), this.timeoutMs);
    this.session.send(TYPES.CLIPBOARD_OFFER, { id, size: content.length, sha256: digest, mime: "text/plain;charset=utf-8" });
  }
  async onFrame(frame) {
    const body = frame.payload;
    if (frame.type === TYPES.FILE_OFFER) {
      if (!this.allowed("files.receive")) throw new Error("RD_SCOPE_DENIED");
      uuidBytes(body.id); safeFilename(body.name); size(body.size, RD.limits.file_bytes);
      if (this.incoming.has(body.id) || this.seen.has(body.id) || this.incoming.size >= RD.limits.batch_files) throw new Error("RD_FILE_LIMIT");
      size([...this.incoming.values()].reduce((total, value) => total + value.offer.size, body.size), RD.limits.batch_file_bytes);
      const item = { offer: body }; this.incoming.set(body.id, item); this.expire(body.id, item, this.incoming); this.onOffer?.(body); return;
    }
    if (frame.type === TYPES.FILE_ACCEPT) {
      const item = this.outgoing.get(body.id); if (!item) throw new Error("RD_FILE_INVALID");
      if (item.accepted || item.digest) throw new Error("RD_FILE_INVALID");
      item.accepted = true;
      void this.sendFile(body.id, item).catch(async (error) => { await this.cancel(body.id).catch(() => {}); this.onProgress?.({ id: body.id, error: error.message }); }); return;
    }
    if (frame.type === TYPES.FILE_CHUNK) {
      if (!this.allowed("files.receive") || body.byteLength <= 24 || body.byteLength > RD.limits.file_chunk_bytes + 24) throw new Error("RD_FILE_INVALID");
      const id = uuid(body.subarray(0,16)), item = this.incoming.get(id), offset = new DataView(body.buffer, body.byteOffset, body.byteLength).getBigUint64(16);
      if (!item?.sink || offset !== BigInt(item.offset) || item.offset + body.length - 24 > item.offer.size) throw new Error("RD_FILE_OFFSET");
      const content = body.subarray(24);
      try { await item.sink.write(content); } catch { await this.cancel(id); this.onProgress?.({ id, error: "RD_FILE_WRITE_FAILED" }); return; }
      if (this.incoming.get(id) !== item || !this.allowed("files.receive")) { await this.cancel(id); return; }
      item.hash.update(content); item.offset += content.length; this.expire(id, item, this.incoming);
      this.session.send(TYPES.FILE_ACK, { id, offset: item.offset });
      this.onProgress?.({ id, received: item.offset, size: item.offer.size }); return;
    }
    if (frame.type === TYPES.FILE_COMPLETE) {
      const item = this.incoming.get(body.id);
      if (!this.allowed("files.receive") || !item?.sink || body.size !== item.offer.size || item.offset !== body.size || !/^[0-9a-f]{64}$/.test(body.sha256) || item.hash.digest() !== body.sha256) { await this.cancel(body.id); throw new Error("RD_FILE_HASH_MISMATCH"); }
      clearTimeout(item.timer);
      try { await item.sink.close(); } catch { await this.cancel(body.id); this.onProgress?.({ id: body.id, error: "RD_FILE_WRITE_FAILED" }); return; }
      this.incoming.delete(body.id); this.remember(body.id);
      this.session.send(TYPES.FILE_ACK, { id: body.id, sha256: body.sha256 }); this.onProgress?.({ id: body.id, complete: true }); return;
    }
    if (frame.type === TYPES.FILE_ACK) {
      const item = this.outgoing.get(body.id);
      if (!item && this.seen.has(body.id)) return;
      if (item?.ack && body.offset === item.ack.offset && body.sha256 === undefined) { const pending = item.ack; item.ack = null; pending.resolve(); return; }
      if (!item?.digest || body.sha256 !== item.digest) throw new Error("RD_FILE_HASH_MISMATCH");
      clearTimeout(item.timer); this.outgoing.delete(body.id); this.remember(body.id); this.onProgress?.({ id: body.id, complete: true }); return;
    }
    if (frame.type === TYPES.FILE_CANCEL) { await this.cancel(body.id, false); return; }
    if (frame.type === TYPES.CLIPBOARD_OFFER) {
      if (!this.allowed("clipboard.read") || this.clipboard || body.mime !== "text/plain;charset=utf-8" || !/^[0-9a-f]{64}$/.test(body.sha256)) throw new Error("RD_SCOPE_DENIED");
      uuidBytes(body.id); size(body.size, RD.limits.clipboard_bytes);
      if (this.seen.has(body.id)) throw new Error("RD_STATE_CONFLICT");
      this.clipboard = { ...body, content: new Uint8Array(body.size), offset: 0 };
      this.clipboard.timer = setTimeout(() => this.clearClipboard(), this.timeoutMs);
      this.session.send(TYPES.CLIPBOARD_ACCEPT, { id: body.id });
      if (body.size === 0) await this.finishClipboard(); return;
    }
    if (frame.type === TYPES.CLIPBOARD_ACCEPT) {
      const item = this.clipboardOutgoing;
      if (!this.allowed("clipboard.write") || !item || item.id !== body.id || item.accepted) throw new Error("RD_STATE_CONFLICT");
      item.accepted = true;
      for (let offset = 0; offset < item.content.length; offset += 8192) {
        await this.room("clipboard"); const chunk = item.content.subarray(offset, offset + 8192), payload = new Uint8Array(chunk.length + 24);
        if (this.clipboardOutgoing !== item || !this.allowed("clipboard.write")) throw new Error("RD_SCOPE_DENIED");
        payload.set(uuidBytes(item.id)); new DataView(payload.buffer).setBigUint64(16, BigInt(offset)); payload.set(chunk, 24); this.session.send(TYPES.CLIPBOARD_CHUNK, payload);
      }
      return;
    }
    if (frame.type === TYPES.CLIPBOARD_CHUNK) {
      if (!this.allowed("clipboard.read") || body.length <= 24) throw new Error("RD_SCOPE_DENIED");
      const item = this.clipboard, offset = new DataView(body.buffer, body.byteOffset, body.byteLength).getBigUint64(16);
      if (!item || uuid(body.subarray(0,16)) !== item.id || offset !== BigInt(item.offset) || item.offset + body.length - 24 > item.size) throw new Error("RD_CLIPBOARD_INVALID");
      item.content.set(body.subarray(24), item.offset); item.offset += body.length - 24;
      if (item.offset === item.size) await this.finishClipboard(); return;
    }
    if (frame.type === TYPES.CLIPBOARD_ACK) {
      if (!this.clipboardOutgoing || body.id !== this.clipboardOutgoing.id) throw new Error("RD_STATE_CONFLICT");
      this.lastClipboardDigest = this.clipboardOutgoing.digest; clearTimeout(this.clipboardOutgoing.timer); this.clipboardOutgoing.content.fill(0); this.clipboardOutgoing = null;
    }
  }
  async finishClipboard() {
    const item = this.clipboard;
    if (hex(await sha256(item.content)) !== item.sha256) throw new Error("RD_CLIPBOARD_INVALID");
    if (this.clipboard !== item || !this.allowed("clipboard.read")) throw new Error("RD_SCOPE_DENIED");
    const text = textDecoder.decode(item.content); clearTimeout(item.timer); item.content.fill(0); this.clipboard = null; this.remember(item.id);
    const duplicate = this.lastClipboardDigest === item.sha256; this.lastClipboardDigest = item.sha256;
    if (!duplicate) await this.onClipboard?.(text);
    this.session.send(TYPES.CLIPBOARD_ACK, { id: item.id });
  }
  remember(id) { this.seen.add(id); if (this.seen.size > 128) this.seen.delete(this.seen.values().next().value); }
  async cancel(id, notify = true) {
    uuidBytes(id);
    const item = this.incoming.get(id); this.incoming.delete(id);
    clearTimeout(item?.timer);
    const outgoing = this.outgoing.get(id); this.outgoing.delete(id); clearTimeout(outgoing?.timer);
    if (outgoing) { outgoing.canceled = true; outgoing.ack?.reject(new Error("RD_FILE_CANCELLED")); outgoing.ack = null; }
    this.remember(id);
    if (item?.sink) await Promise.resolve().then(() => item.sink.abort()).catch(() => {});
    if (notify && !this.closed && (item || outgoing)) this.session.send(TYPES.FILE_CANCEL, { id, reason: "cancelled" });
  }
  clearClipboard() {
    for (const item of [this.clipboard, this.clipboardOutgoing]) { clearTimeout(item?.timer); item?.content.fill(0); }
    this.clipboard = null; this.clipboardOutgoing = null;
  }
  async revoke(permission) {
    if (permission.startsWith("clipboard.")) this.clearClipboard();
    const collection = permission === "files.send" ? this.outgoing : permission === "files.receive" ? this.incoming : new Map();
    for (const id of [...collection.keys()]) await this.cancel(id);
  }
  async close() {
    this.closed = true;
    for (const reject of [...this.waiters]) reject();
    for (const id of [...this.incoming.keys(), ...this.outgoing.keys()]) await this.cancel(id, false);
    this.clearClipboard();
  }
}
