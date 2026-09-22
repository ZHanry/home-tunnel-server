import { base64url, publicJwk, sha256, thumbprint, unbase64url, verifyJws, signJws } from "./identity.js";
import { RD, TYPES, canonicalJson, decodeFrame, directCandidate, encodeFrame, proofTranscript, strictJson, validateSdp } from "./protocol.js";
import { RemoteError } from "./http.js";

export class LeaseDeadline {
  constructor(clock = () => performance.now()) { this.clock = clock; this.deadline = 0; this.sequence = 0; }
  update(claims, now = Date.now()) {
    if (!Number.isSafeInteger(claims.exp) || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.lease_seq) || claims.exp <= now / 1000 || claims.iat > now / 1000 + 30 || claims.exp - claims.iat > 900 || claims.lease_seq <= this.sequence || (this.sequence && !this.valid())) throw new RemoteError("RD_LEASE_EXPIRED");
    this.deadline = this.clock() + Math.min(claims.exp * 1000 - now, (claims.exp - claims.iat) * 1000);
    this.sequence = claims.lease_seq;
  }
  valid() { return this.sequence > 0 && this.clock() < this.deadline; }
}

export class PeerReplayWindow {
  constructor() { this.highest = 0n; this.seen = new Set(); }
  accept(sequence, unordered = false) {
    if (typeof sequence !== "string" || !/^[1-9][0-9]{0,19}$/.test(sequence)) throw new RemoteError("RD_PROOF_INVALID");
    const value = BigInt(sequence);
    if (value > 0xffffffffffffffffn || this.seen.has(sequence) || value + 32n <= this.highest || (!unordered && value <= this.highest)) throw new RemoteError("RD_PROOF_INVALID");
    if (value > this.highest) this.highest = value;
    this.seen.add(sequence);
    for (const item of this.seen) if (BigInt(item) + 32n <= this.highest) this.seen.delete(item);
  }
}

export function selectedUdpPair(stats) {
  const values = [...stats.values()];
  const transport = values.find((item) => item.type === "transport" && item.selectedCandidatePairId);
  const pair = transport ? stats.get(transport.selectedCandidatePairId) : values.find((item) => item.type === "candidate-pair" && item.state === "succeeded" && item.nominated);
  if (!pair) return null;
  const local = stats.get(pair.localCandidateId), remote = stats.get(pair.remoteCandidateId);
  for (const candidate of [local, remote]) {
    if (!candidate) continue;
    if ((candidate.protocol && candidate.protocol.toLowerCase() !== "udp") || (candidate.candidateType && !["host", "srflx", "prflx"].includes(candidate.candidateType)) || candidate.relayProtocol || candidate.tcpType) throw new RemoteError("RD_PATH_REJECTED");
  }
  return { id: pair.id, verified: [local, remote].every((candidate) => candidate?.protocol?.toLowerCase() === "udp" && ["host", "srflx", "prflx"].includes(candidate.candidateType)) };
}

export class RemoteSession {
  constructor({ api, signal, session, hostThumbprint, video, onState, onControl, onReconnectNeeded }) {
    this.api = api; this.signal = signal; this.snapshot = session; this.hostThumbprint = hostThumbprint;
    this.video = video; this.onState = onState; this.onControl = onControl;
    this.onReconnectNeeded = onReconnectNeeded;
    this.epoch = session.connection_epoch; this.id = session.session_id;
    this.channels = new Map(); this.sequences = new Map(); this.received = new Map(); this.peerReplay = new PeerReplayWindow(); this.frameQueues = new Map();
    this.lease = new LeaseDeadline(); this.closed = false; this.ready = false; this.inputEpoch = 0;
    this.inputEnabled = false; this.peerVerified = false; this.pathVerified = false; this.signalSequence = 0n;
    this.candidates = []; this.pendingCandidates = []; this.abort = new AbortController();
    this.controllerNonce = crypto.getRandomValues(new Uint8Array(32));
    this.permissions = new Set(session.permissions); this.featureState = new Set(); this.featureRequests = new Map();
  }
  async serverClaims(jws, type, audience) {
    const header = strictJson(new TextDecoder().decode(unbase64url(jws.split(".")[0], 2048)), 2048);
    const key = this.api.keys.keys.find((item) => item.kid === header.kid);
    if (!key || key.alg !== "ES256") throw new RemoteError("RD_PROOF_INVALID");
    const claims = await verifyJws(jws, key.public_jwk, type, { kid: key.kid });
    const now = Date.now() / 1000;
    if (claims.iss !== location.origin || claims.aud !== audience || claims.server_instance_id !== this.api.keys.server_instance_id || claims.restore_epoch !== this.api.keys.restore_epoch || claims.session_id !== this.id || claims.connection_epoch !== this.epoch || claims.owner_user_id !== this.api.userId || claims.controller_endpoint_id !== this.api.identity.endpointId || claims.host_endpoint_id !== this.snapshot.host_endpoint_id || claims.controller_jkt !== this.api.identity.jkt || claims.host_jkt !== this.hostThumbprint || !Number.isSafeInteger(claims.exp) || !Number.isSafeInteger(claims.nbf) || claims.nbf > now + 30 || claims.exp <= now || !Array.isArray(claims.permissions) || claims.permissions.some((permission) => !this.permissions.has(permission)) || !claims.permissions.includes("view")) throw new RemoteError("RD_PROOF_INVALID");
    if (new Set(claims.permissions).size !== this.permissions.size || [...this.permissions].some((permission) => !claims.permissions.includes(permission)) || (this.ticket && (claims.grant_id !== this.ticket.grant_id || claims.grant_version !== this.ticket.grant_version || claims.user_token_version !== this.ticket.user_token_version))) throw new RemoteError("RD_GRANT_CHANGED");
    return claims;
  }
  async authorize() {
    if (await thumbprint(this.snapshot.host_public_jwk) !== this.hostThumbprint) throw new RemoteError("RD_PEER_IDENTITY_MISMATCH");
    this.hostKey = await crypto.subtle.importKey("jwk", publicJwk(this.snapshot.host_public_jwk), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    this.ticket = await this.serverClaims(this.snapshot.ticket_jws, "ht-rd-ticket+jwt", "ht-rd-start");
    const grant = await verifyJws(this.snapshot.grant_jws, this.snapshot.host_public_jwk, "ht-rd-grant+jwt");
    if (grant.id !== this.ticket.grant_id || grant.grant_version !== this.ticket.grant_version || grant.server_instance_id !== this.ticket.server_instance_id || grant.owner_user_id !== this.api.userId || grant.host_endpoint_id !== this.ticket.host_endpoint_id || grant.controller_endpoint_id !== this.ticket.controller_endpoint_id || grant.host_jkt !== this.hostThumbprint || grant.controller_jkt !== this.api.identity.jkt || !Array.isArray(grant.scope) || [...this.permissions].some((permission) => !grant.scope.includes(permission)) || (grant.expires_at && Date.parse(grant.expires_at) <= Date.now())) throw new RemoteError("RD_GRANT_CHANGED");
    this.permissions = new Set(this.ticket.permissions);
    this.lease.update(await this.serverClaims(this.snapshot.lease_jws, "ht-rd-lease+jwt", "ht-rd-use"));
  }
  async start(stunUrls) {
    await this.authorize();
    if (this.closed) throw new RemoteError("RD_SESSION_REVOKED");
    if (!Array.isArray(stunUrls) || stunUrls.length > 4 || stunUrls.some((url) => !/^stun:(?:[a-z0-9.-]+|\[[0-9a-f:]+\]):\d{1,5}$/i.test(url))) throw new RemoteError("RD_PATH_REJECTED");
    this.onState?.("connecting");
    this.pc = new RTCPeerConnection({ iceServers: stunUrls.map((urls) => ({ urls })), iceTransportPolicy: "all", bundlePolicy: "max-bundle" });
    this.pc.addTransceiver("video", { direction: "recvonly" });
    if (this.permissions.has("audio.system")) this.pc.addTransceiver("audio", { direction: "recvonly" });
    if (this.permissions.has("audio.microphone")) this.microphoneTransceiver = this.pc.addTransceiver("audio", { direction: "sendonly" });
    for (const [name, definition] of Object.entries(RD.channels)) {
      if (name === "clipboard" && !["clipboard.read", "clipboard.write"].some((p) => this.permissions.has(p))) continue;
      if (name === "file" && !["files.send", "files.receive"].some((p) => this.permissions.has(p))) continue;
      const channel = this.pc.createDataChannel(name, { ordered: definition.ordered, ...(definition.max_retransmits === undefined ? {} : { maxRetransmits: definition.max_retransmits }) });
      channel.binaryType = "arraybuffer"; this.channels.set(name, channel);
      channel.onmessage = (event) => this.enqueueFrame(event.data, name);
      channel.onclose = () => { if (!this.closed) this.fail(new RemoteError("RD_MEDIA_FAILED")); };
      channel.onopen = () => { if (name === "control") this.sendHello().catch((error) => this.fail(error)); };
    }
    this.pc.ondatachannel = (event) => { event.channel.close(); this.fail(new RemoteError("RD_PROTOCOL_MISMATCH")); };
    this.pc.onicecandidate = (event) => {
      if (this.closed) return;
      if (!event.candidate) return;
      try { directCandidate(event.candidate.candidate); } catch { return; }
      if (this.candidates.length >= 32) return;
      const item = event.candidate.toJSON(); this.candidates.push(item);
      if (this.offerJws) this.sendPeer("peer.candidates", { candidates: [item] }).catch((error) => this.fail(error));
    };
    this.pc.ontrack = (event) => {
      if (event.track.kind === "video") this.videoTrack = event.track;
      else if (event.track.kind === "audio") { event.track.enabled = false; this.audioTrack = event.track; }
      this.attachVerifiedTracks();
    };
    this.pc.onconnectionstatechange = () => {
      if (["disconnected", "failed", "closed"].includes(this.pc.connectionState)) {
        this.releaseInput(); this.pathVerified = false; this.video.pause();
        if (!this.closed && this.ready && this.onReconnectNeeded) this.onReconnectNeeded("ice_failed");
        else this.fail(new RemoteError("RD_NO_DIRECT_PATH"));
      }
    };
    this.timer = setInterval(() => {
      if (!this.lease.valid()) { this.fail(new RemoteError("RD_LEASE_EXPIRED")); return; }
      if (this.inputEnabled) {
        try { this.send(TYPES.INPUT_HEARTBEAT, { input_epoch: this.inputEpoch, state_version: this.inputEpoch, ...(this.inputState?.() ?? { keys: [], buttons: 0 }) }); }
        catch (error) { this.fail(error); }
      }
    }, 250);
    this.pathTimer = setInterval(() => {
      if (this.closed || !this.pathVerified || this.checkingPath) return;
      this.checkingPath = true;
      this.inspectPath().catch((error) => this.fail(error)).finally(() => { this.checkingPath = false; });
    }, 1000);
    this.iceTimer = setTimeout(() => this.fail(new RemoteError("RD_NO_DIRECT_PATH")), RD.limits.ice_deadline_ms);
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.offerJws = await this.sendPeer("peer.offer", { sdp: validateSdp(offer.sdp), type: "offer" });
    if (this.candidates.length) await this.sendPeer("peer.candidates", { candidates: this.candidates });
    document.addEventListener("visibilitychange", () => { if (document.hidden) { this.releaseInput(); void this.stopMicrophone(); } }, { signal: this.abort.signal });
    window.addEventListener("blur", () => this.releaseInput(), { signal: this.abort.signal });
  }
  async sendPeer(type, payload) {
    if (this.closed || !this.lease.valid()) throw new RemoteError("RD_SESSION_REVOKED");
    const signed = await signJws(this.api.identity, { v: 1, type, session_id: this.id, connection_epoch: this.epoch, from_endpoint_id: this.api.identity.endpointId, to_endpoint_id: this.snapshot.host_endpoint_id, seq: String(++this.signalSequence), ticket_jti: this.ticket.jti, created_at: new Date().toISOString(), payload }, "ht-rd-peer+jwt");
    this.signal.send({ v: 1, type, request_id: crypto.randomUUID(), session_id: this.id, connection_epoch: this.epoch, payload_jws: signed });
    return signed;
  }
  async onSignal(message) {
    if (this.closed || message.session_id !== this.id || message.connection_epoch !== this.epoch) return;
    if (message.type === "session.revoked" || message.type === "session.close") { this.close(); return; }
    if (!message.type.startsWith("peer.")) return;
    const claims = await verifyJws(message.payload_jws, this.snapshot.host_public_jwk, "ht-rd-peer+jwt");
    if (claims.v !== 1 || claims.type !== message.type || claims.session_id !== this.id || claims.connection_epoch !== this.epoch || claims.from_endpoint_id !== this.snapshot.host_endpoint_id || claims.to_endpoint_id !== this.api.identity.endpointId || claims.ticket_jti !== this.ticket.jti || !Number.isFinite(Date.parse(claims.created_at)) || Math.abs(Date.now() - Date.parse(claims.created_at)) > 120000) throw new RemoteError("RD_PROOF_INVALID");
    this.peerReplay.accept(claims.seq, message.type === "peer.candidates");
    if (message.type === "peer.answer") {
      if (this.answerJws || claims.payload.type !== "answer") throw new RemoteError("RD_STATE_CONFLICT");
      this.answerJws = message.payload_jws;
      await this.pc.setRemoteDescription({ type: "answer", sdp: validateSdp(claims.payload.sdp) });
      for (const candidate of this.pendingCandidates) await this.pc.addIceCandidate(candidate);
      this.pendingCandidates = [];
    } else if (message.type === "peer.candidates") {
      if (!Array.isArray(claims.payload.candidates) || (this.remoteCandidateCount ?? 0) + claims.payload.candidates.length > 32) throw new RemoteError("RD_PROTOCOL_MISMATCH");
      for (const candidate of claims.payload.candidates) {
        directCandidate(candidate.candidate);
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(candidate); else this.pendingCandidates.push(candidate);
      }
      this.remoteCandidateCount = (this.remoteCandidateCount ?? 0) + claims.payload.candidates.length;
    }
  }
  async sendHello() {
    if (!this.answerJws || !this.offerJws) throw new RemoteError("RD_STATE_CONFLICT");
    this.send(TYPES.SESSION_HELLO, { nonce: base64url(this.controllerNonce), ticket_hash: base64url(await sha256(this.snapshot.ticket_jws)), protocol: { major: 1, minor: 0 }, capability_hash: base64url(await sha256(canonicalJson({ permissions: [...this.permissions] }))) });
    this.authTimer = setTimeout(() => this.fail(new RemoteError("RD_PEER_IDENTITY_MISMATCH")), 5000);
  }
  enqueueFrame(data, name) {
    const size = data?.byteLength ?? 0;
    this.pendingBytes = (this.pendingBytes ?? 0) + size;
    if (this.pendingBytes > RD.limits.send_queue_bytes) { this.fail(new RemoteError("RD_MESSAGE_TOO_LARGE")); return; }
    this.pendingCount = (this.pendingCount ?? 0) + 1;
    if (this.pendingCount > 128) { this.fail(new RemoteError("RD_MESSAGE_TOO_LARGE")); return; }
    const queue = (this.frameQueues.get(name) ?? Promise.resolve()).then(async () => {
      try { if (!this.closed) await this.onFrame(decodeFrame(data, name), name); }
      finally { this.pendingBytes -= size; this.pendingCount--; }
    }).catch((error) => this.fail(error));
    this.frameQueues.set(name, queue);
  }
  async onFrame(frame, channel) {
    if (!this.lease.valid() || frame.epoch !== this.epoch) throw new RemoteError("RD_STATE_CONFLICT");
    const previous = this.received.get(channel) ?? 0;
    if (frame.sequence <= previous) return;
    if (RD.channels[channel].ordered && frame.sequence !== previous + 1) throw new RemoteError("RD_PROTOCOL_MISMATCH");
    this.received.set(channel, frame.sequence);
    const body = frame.payload;
    if (frame.type === TYPES.SESSION_HELLO) {
      if (this.transcript || body.protocol?.major !== 1 || body.protocol?.minor !== 0 || body.ticket_hash !== base64url(await sha256(this.snapshot.ticket_jws))) throw new RemoteError("RD_PROOF_INVALID");
      this.transcript = proofTranscript({ sessionId: this.id, epoch: this.epoch, controllerNonce: this.controllerNonce, hostNonce: unbase64url(body.nonce, 32), offerHash: await sha256(this.offerJws), answerHash: await sha256(this.answerJws), ticketHash: await sha256(this.snapshot.ticket_jws) });
      const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.api.identity.privateKey, this.transcript);
      this.send(TYPES.SESSION_PROOF, { transcript_version: 1, signature: base64url(signature), jkt: this.api.identity.jkt });
      return;
    }
    if (frame.type === TYPES.SESSION_PROOF) {
      if (!this.transcript || this.peerVerified || body.transcript_version !== 1 || body.jkt !== this.hostThumbprint || !await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, this.hostKey, unbase64url(body.signature, 64), this.transcript)) throw new RemoteError("RD_PEER_IDENTITY_MISMATCH");
      this.peerVerified = true; clearTimeout(this.authTimer); return;
    }
    if (!this.peerVerified) throw new RemoteError("RD_PEER_IDENTITY_MISMATCH");
    if (frame.type === TYPES.PATH_VERIFIED) {
      if (body.epoch !== this.epoch || body.protocol !== "udp" || !["host", "srflx", "prflx"].includes(body.local_candidate_type) || !["host", "srflx", "prflx"].includes(body.remote_candidate_type)) throw new RemoteError("RD_PATH_REJECTED");
      await this.inspectPath();
      this.pathVerified = true; clearTimeout(this.iceTimer); this.attachVerifiedTracks();
      return;
    }
    if (frame.type === TYPES.PAUSE || frame.type === TYPES.CONTROL_RELEASED) { this.releaseInput(); return; }
    if (frame.type === TYPES.SESSION_CLOSE) { this.close(); return; }
    if (!this.pathVerified) throw new RemoteError("RD_PATH_REJECTED");
    if (frame.type === TYPES.CAPABILITIES) {
      this.remoteCapabilities = body;
      this.send(TYPES.CAPABILITIES_ACK, { capability_hash: base64url(await sha256(canonicalJson(body))), permissions: [...this.permissions] });
    } else if (frame.type === TYPES.DISPLAY_LAYOUT) {
      if (!Number.isSafeInteger(body.layout_epoch) || body.layout_epoch <= (this.layout?.layout_epoch ?? 0) || !Array.isArray(body.displays) || body.displays.length < 1 || body.displays.length > 16 || new Set(body.displays.map((display) => display.id)).size !== body.displays.length || new Set(body.displays.map((display) => display.slot)).size !== body.displays.length || !body.displays.some((display) => display.id === body.active_display) || body.displays.some((display) => typeof display.id !== "string" || display.id.length > 128 || !Number.isInteger(display.slot) || display.slot < 0 || display.slot > 65535 || !Number.isInteger(display.width_px) || display.width_px < 1 || display.width_px > 32768 || !Number.isInteger(display.height_px) || display.height_px < 1 || display.height_px > 32768)) throw new RemoteError("RD_PROTOCOL_MISMATCH");
      this.releaseInput(); this.layout = body;
    } else if (frame.type === TYPES.SESSION_READY) {
      if (body.epoch !== this.epoch || !this.layout || !this.remoteCapabilities) throw new RemoteError("RD_STATE_CONFLICT");
      this.ready = true; this.send(TYPES.SESSION_READY, { epoch: this.epoch, permissions: [...this.permissions], lease_seq: this.lease.sequence });
      this.attachVerifiedTracks(); this.onState?.("waiting_for_frame");
    } else if (frame.type === TYPES.CONTROL_GRANTED) {
      if (!this.inputRequested || !this.ready || !Number.isSafeInteger(body.new_input_epoch) || body.new_input_epoch <= this.inputEpoch) throw new RemoteError("RD_STATE_CONFLICT");
      this.inputEpoch = body.new_input_epoch;
      this.send(TYPES.INPUT_STATE, { generation: this.inputEpoch, keys: [], buttons: 0, motion_sequence: 0 });
    } else if (frame.type === TYPES.INPUT_SYNC_ACK) {
      if (!this.inputRequested || body.input_epoch !== this.inputEpoch || body.layout_epoch !== this.layout?.layout_epoch || document.hidden) throw new RemoteError("RD_STATE_CONFLICT");
      this.inputEnabled = true;
    } else if (frame.type === TYPES.FEATURE_STATE) {
      const pending = this.featureRequests.get(body.permission);
      if (typeof body.enabled !== "boolean" || !this.permissions.has(body.permission) || (body.enabled === true && (!pending && !this.featureState.has(body.permission)))) throw new RemoteError("RD_SCOPE_DENIED");
      if (body.enabled === true) this.featureState.add(body.permission); else this.featureState.delete(body.permission);
      if (pending) {
        clearTimeout(pending.timer); this.featureRequests.delete(body.permission);
        if (pending.enabled === body.enabled) pending.resolve(); else pending.reject(new RemoteError(body.error_code ?? "RD_FEATURE_DENIED"));
      }
      if (body.enabled !== true && body.permission === "audio.microphone") void this.stopMicrophone();
      if (body.enabled !== true && body.permission === "audio.system" && this.audioTrack) this.audioTrack.enabled = false;
    }
    await this.onControl?.(frame);
  }
  async inspectPath() {
    const pair = selectedUdpPair(await this.pc.getStats());
    if (this.closed) return;
    if (pair && this.selectedPair && pair.id !== this.selectedPair.id) {
      this.releaseInput(); this.pathVerified = false; this.video.pause(); await this.stopMicrophone();
      throw new RemoteError("RD_PATH_CHANGED");
    }
    if (pair) this.selectedPair = pair;
  }
  attachVerifiedTracks() {
    if (this.closed || this.attached || !this.peerVerified || !this.pathVerified || !this.ready || !this.videoTrack) return;
    this.attached = true;
    this.video.srcObject = new MediaStream([this.videoTrack, ...(this.audioTrack ? [this.audioTrack] : [])]);
    const firstFrame = () => {
      if (this.closed || !this.pathVerified) return;
      clearTimeout(this.frameTimer); this.onState?.("viewing");
      void this.reportReady().catch((error) => this.fail(error));
    };
    if (this.video.requestVideoFrameCallback) this.frameCallback = this.video.requestVideoFrameCallback(firstFrame);
    else this.video.addEventListener("loadeddata", firstFrame, { once: true, signal: this.abort.signal });
    this.frameTimer = setTimeout(() => this.fail(new RemoteError("RD_MEDIA_FAILED")), 5000);
    this.video.play().catch(() => { clearTimeout(this.frameTimer); this.onState?.("playback_gesture_required"); });
  }
  async resumePlayback() {
    if (!this.ready || !this.pathVerified) throw new RemoteError("RD_MEDIA_FAILED");
    clearTimeout(this.frameTimer); this.frameTimer = setTimeout(() => this.fail(new RemoteError("RD_MEDIA_FAILED")), 5000);
    await this.video.play();
  }
  selectDisplay(id) {
    if (!this.ready || !this.layout?.displays.some((display) => display.id === id)) throw new RemoteError("RD_STATE_CONFLICT");
    this.releaseInput(); this.send(TYPES.DISPLAY_SELECT, { display_id: id, layout_epoch: this.layout.layout_epoch });
  }
  async reportReady() {
    const snapshot = await this.api.request(`/api/v1/rd/sessions/${this.id}`);
    if (this.closed || !this.pathVerified || !this.lease.valid()) return;
    await this.api.request(`/api/v1/rd/sessions/${this.id}/report`, { method: "POST", body: { phase: "ready", connection_epoch: this.epoch, expected_version: snapshot.state_version, path_verified: true } });
  }
  setFeature(permission, enabled) {
    if (!this.ready || !this.permissions.has(permission) || this.featureRequests.has(permission)) return Promise.reject(new RemoteError("RD_SCOPE_DENIED"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.featureRequests.delete(permission); reject(new RemoteError("RD_FEATURE_TIMEOUT")); }, 10000);
      this.featureRequests.set(permission, { enabled, resolve, reject, timer });
      try { this.send(TYPES.FEATURE_REQUEST, { permission, enabled }); }
      catch (error) { clearTimeout(timer); this.featureRequests.delete(permission); reject(error); }
    });
  }
  async setSystemAudio(enabled) {
    await this.setFeature("audio.system", enabled);
    if (!this.audioTrack) throw new RemoteError("RD_MEDIA_FAILED");
    this.audioTrack.enabled = enabled; this.video.muted = !enabled;
  }
  send(type, payload) {
    if (this.closed || !this.lease.valid()) throw new RemoteError("RD_SESSION_REVOKED");
    const name = Object.values(RD.messages).find((entry) => entry.id === type)?.channel;
    const channel = this.channels.get(name);
    if (!channel || channel.readyState !== "open") throw new RemoteError("RD_MEDIA_FAILED");
    const isInput = name === "input" || name === "motion";
    if (isInput && (!this.ready || !this.pathVerified || !this.inputEnabled)) throw new RemoteError("RD_INPUT_DENIED");
    const sequence = (this.sequences.get(name) ?? 0) + 1;
    const encoded = encodeFrame(type, payload, { epoch: this.epoch, inputEpoch: isInput ? this.inputEpoch : 0, sequence });
    if (channel.bufferedAmount + encoded.length > RD.limits.send_queue_bytes) throw new RemoteError("RD_MEDIA_BACKPRESSURE");
    channel.send(encoded); this.sequences.set(name, sequence);
  }
  requestInput() {
    if (!this.ready || !this.video.videoWidth || document.hidden) throw new RemoteError("RD_INPUT_DENIED");
    this.inputRequested = true;
    this.send(TYPES.CONTROL_REQUEST, { requested_input_permissions: [...this.permissions].filter((value) => value.startsWith("input.")) });
  }
  releaseInput() {
    const notify = this.inputEnabled || this.inputRequested;
    this.inputEnabled = false; this.inputRequested = false;
    this.clearInputState?.();
    if (notify && !this.closed) { try { this.send(TYPES.RELEASE_ALL, { reason: "controller_released" }); } catch {} }
  }
  async startMicrophone() {
    if (!this.ready || !this.permissions.has("audio.microphone") || !this.microphoneTransceiver || document.hidden) throw new RemoteError("RD_INPUT_DENIED");
    await this.setFeature("audio.microphone", true);
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }); }
    catch (error) { await this.setFeature("audio.microphone", false).catch(() => {}); throw error; }
    if (this.closed || document.hidden || !this.lease.valid()) { stream.getTracks().forEach((track) => track.stop()); throw new RemoteError("RD_SESSION_REVOKED"); }
    this.microphone = stream;
    if (!this.featureState.has("audio.microphone")) { stream.getTracks().forEach((track) => track.stop()); this.microphone = null; throw new RemoteError("RD_FEATURE_APPROVAL_REQUIRED"); }
    try { await this.microphoneTransceiver.sender.replaceTrack(stream.getAudioTracks()[0]); }
    catch (error) { await this.stopMicrophone(); await this.setFeature("audio.microphone", false).catch(() => {}); throw error; }
  }
  async stopMicrophone() {
    this.microphone?.getTracks().forEach((track) => track.stop()); this.microphone = null;
    if (this.microphoneTransceiver) await this.microphoneTransceiver.sender.replaceTrack(null).catch(() => {});
  }
  fail(error) { if (!this.closed) { this.close(); this.onState?.("failed", error); } }
  close({ remote = true } = {}) {
    if (this.closed) return;
    this.releaseInput(); this.closed = true; this.ready = false; this.abort.abort();
    clearInterval(this.timer); clearInterval(this.pathTimer); clearTimeout(this.iceTimer); clearTimeout(this.authTimer); clearTimeout(this.frameTimer);
    if (this.frameCallback !== undefined) this.video.cancelVideoFrameCallback?.(this.frameCallback);
    for (const pending of this.featureRequests.values()) { clearTimeout(pending.timer); pending.reject(new RemoteError("RD_SESSION_REVOKED")); }
    this.featureRequests.clear();
    void this.stopMicrophone(); this.channels.forEach((channel) => channel.close()); this.channels.clear(); this.pc?.close();
    this.video.pause(); this.video.srcObject = null;
    if (remote) this.closeRequest = this.api.request(`/api/v1/rd/sessions/${this.id}/close`, { method: "POST", body: {} }).catch(() => {});
    this.onState?.("closed");
  }
}
