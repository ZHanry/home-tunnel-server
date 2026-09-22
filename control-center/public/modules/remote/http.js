import { browserIdentity, dpop, signJws } from "./identity.js";
import { strictJson } from "./protocol.js";

export class RemoteError extends Error {
  constructor(code, message = code, status = 0) { super(message); this.code = code; this.status = status; }
}

export class RemoteApi {
  constructor(accountApi, userId) {
    this.accountApi = accountApi; this.userId = userId;
    this.token = null; this.nonce = null; this.refreshing = null;
    this.abort = new AbortController();
  }
  async initialize() {
    this.keys = await this.accountApi("/api/v1/rd/server-keys");
    this.identity = await browserIdentity(this.keys.server_instance_id, this.userId);
    await this.identity.pinServer(this.keys);
    if (!this.identity.endpointId) {
      const challenge = await this.accountApi("/api/v1/rd/enrollment-challenges", { method: "POST", body: JSON.stringify({ endpoint_kind: "browser", role: "controller", public_jwk: this.identity.jwk }) });
      const expected = challenge.proof_payload;
      if (expected.purpose !== "enrollment" || expected.server_instance_id !== this.keys.server_instance_id || expected.endpoint_kind !== "browser" || expected.role !== "controller" || expected.public_jwk?.x !== this.identity.jwk.x || expected.public_jwk?.y !== this.identity.jwk.y) throw new RemoteError("RD_PROOF_INVALID");
      const result = await this.accountApi("/api/v1/rd/endpoints", { method: "POST", body: JSON.stringify({ challenge_id: challenge.challenge_id, signed_proof: await signJws(this.identity, expected), name: "Web browser", platform: "browser" }) });
      await this.identity.saveEndpoint(result.endpoint.id);
      this.identity.endpointId = result.endpoint.id;
      this.acceptToken(result);
    } else await this.refresh();
    return this;
  }
  acceptToken(result) {
    if (this.abort.signal.aborted) throw new RemoteError("RD_SESSION_REVOKED");
    if (typeof result.token !== "string" || typeof result.dpop_nonce !== "string" || !Number.isFinite(Date.parse(result.expires_at))) throw new RemoteError("RD_PROOF_INVALID");
    this.token = result.token; this.nonce = result.dpop_nonce; this.expires = Date.parse(result.expires_at);
  }
  async refresh() {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const challenge = await this.accountApi("/api/v1/rd/token-challenges", { method: "POST", body: JSON.stringify({ endpoint_id: this.identity.endpointId, purpose: "controller_refresh" }) });
        if (challenge.proof_payload.endpoint_id !== this.identity.endpointId || challenge.proof_payload.purpose !== "controller_refresh" || challenge.proof_payload.server_instance_id !== this.keys.server_instance_id) throw new RemoteError("RD_PROOF_INVALID");
        const result = await this.accountApi("/api/v1/rd/tokens", { method: "POST", body: JSON.stringify({ challenge_id: challenge.challenge_id, endpoint_id: this.identity.endpointId, proof: await signJws(this.identity, challenge.proof_payload) }) });
        this.acceptToken(result);
      })().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }
  async request(path, { method = "GET", body, idempotencyKey } = {}) {
    if (!path.startsWith("/api/v1/rd/") || new URL(path, location.origin).origin !== location.origin) throw new RemoteError("RD_PROOF_INVALID");
    if (this.abort.signal.aborted) throw new RemoteError("RD_SESSION_REVOKED");
    if (!this.token || this.expires - Date.now() < 120000) await this.refresh();
    const headers = { accept: "application/json", authorization: `DPoP ${this.token}`, DPoP: await dpop(this.identity, this.token, this.nonce, method, path) };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const response = await fetch(path, { method, credentials: "same-origin", headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(20000)]) });
    if (response.status === 204) return null;
    const content = strictJson(await response.text(), 262144);
    if (!response.ok) throw new RemoteError(content.error_code ?? "RD_REQUEST_FAILED", content.message, response.status);
    return content;
  }
  close() { this.abort.abort(); this.token = null; this.nonce = null; }
}
