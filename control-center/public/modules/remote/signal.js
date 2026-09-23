import { base64url, sha256, signJws } from "./identity.js";
import { strictJson } from "./protocol.js";
import { RemoteError } from "./http.js";

export class RemoteSignal {
  constructor(api, onMessage, onClose) {
    this.api = api; this.onMessage = onMessage; this.onClose = onClose;
    this.socket = null; this.closed = false; this.authenticated = false; this.queue = Promise.resolve();
    this.pendingCount = 0; this.pendingBytes = 0;
  }
  async connect() {
    const ticket = await this.api.request("/api/v1/rd/signal-tickets", { method: "POST", body: { purpose: "connect" } });
    if (this.closed) throw new RemoteError("RD_SESSION_REVOKED");
    const target = new URL(ticket.signal_path, location.origin);
    if (target.origin !== location.origin || target.pathname !== "/api/v1/rd/signal" || target.search || target.hash || ticket.subprotocol !== "ht.rd.signal.v1") throw new RemoteError("RD_PROOF_INVALID");
    target.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    this.socket = new WebSocket(target, ticket.subprotocol);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { reject(new RemoteError("RD_SIGNAL_TIMEOUT")); this.close(); }, 10000);
      this.socket.onmessage = (event) => {
        const length = typeof event.data === "string" ? new TextEncoder().encode(event.data).length : Infinity;
        if (length > 65536 || ++this.pendingCount > 64 || (this.pendingBytes += length) > 262144) { this.fail(new RemoteError("RD_MESSAGE_TOO_LARGE"), reject); return; }
        this.queue = this.queue.then(async () => {
          if (this.closed) return;
          const message = strictJson(event.data, 65536);
          if (message.v !== 1 || typeof message.type !== "string") throw new RemoteError("RD_PROTOCOL_MISMATCH");
          if (message.type === "auth.challenge" && !this.authenticated) {
            if (this.authSent) throw new RemoteError("RD_PROOF_INVALID");
            this.authSent = true;
            const proof = await signJws(this.api.identity, { connection_id: message.connection_id, nonce: message.nonce, ticket_hash: base64url(await sha256(ticket.ticket)), endpoint_id: this.api.identity.endpointId }, "ht-rd-signal+jwt");
            this.send({ v: 1, type: "auth", ticket: ticket.ticket, proof }, true);
          } else if (message.type === "auth.ok" && this.authSent && !this.authenticated) {
            if (message.endpoint_id !== this.api.identity.endpointId) throw new RemoteError("RD_PROOF_INVALID");
            clearTimeout(timeout); this.authenticated = true;
            this.heartbeat = setInterval(() => { try { this.send({ v: 1, type: "ping" }); } catch (error) { this.fail(error); } }, 60000);
            resolve(this);
          } else if (!this.authenticated) throw new RemoteError("RD_AUTH_REQUIRED");
          else if (message.type === "auth.reauth_required") {
            await this.api.refresh();
            const renewal = await this.api.request("/api/v1/rd/signal-tickets", { method: "POST", body: { purpose: "reauth" } });
            const proof = await signJws(this.api.identity, { connection_id: message.connection_id, nonce: message.nonce, ticket_hash: base64url(await sha256(renewal.ticket)), endpoint_id: this.api.identity.endpointId }, "ht-rd-signal+jwt");
            this.send({ v: 1, type: "auth.reauth", ticket: renewal.ticket, proof });
          }
          else if (message.type === "auth.renewed") {
            if (message.endpoint_id !== this.api.identity.endpointId) throw new RemoteError("RD_PROOF_INVALID");
          }
          else if (message.type === "ping") this.send({ v: 1, type: "pong" });
          else if (message.type !== "pong") await this.onMessage(message);
        }).catch((error) => { clearTimeout(timeout); this.fail(error, reject); }).finally(() => { this.pendingCount--; this.pendingBytes -= length; });
      };
      this.socket.onerror = () => { clearTimeout(timeout); this.fail(new RemoteError("RD_SIGNAL_UNAVAILABLE"), reject); };
      this.socket.onclose = () => { clearTimeout(timeout); if (!this.closed) this.fail(new RemoteError("RD_SIGNAL_CLOSED"), reject); };
    });
  }
  send(message, authentication = false) {
    if (this.closed || this.socket?.readyState !== WebSocket.OPEN || (!this.authenticated && !authentication)) throw new RemoteError("RD_SIGNAL_CLOSED");
    const encoded = JSON.stringify(message);
    if (new TextEncoder().encode(encoded).length > 65536 || this.socket.bufferedAmount + encoded.length > 262144) throw new RemoteError("RD_SIGNAL_BACKPRESSURE");
    this.socket.send(encoded);
  }
  fail(error, reject) { reject?.(error); const notify = !this.closed; this.close(); if (notify) this.onClose?.(error); }
  close() { this.closed = true; this.authenticated = false; clearInterval(this.heartbeat); this.socket?.close(1000); this.socket = null; }
}
