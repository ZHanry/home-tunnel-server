// UI-only protocol adapters for the local preview. No peer, network transport,
// remote authorization or media acceptance is established by these fixtures.
export async function installSessionUiFixtures(context, item) {
  await context.route('**/api/v1/rd/reauth', route => route.fulfill({ json: { verified_at: new Date().toISOString() } }));
  await context.route('**/modules/remote/http.js', route => route.fulfill({ contentType: 'text/javascript', body: `
    import { canonicalJson } from '/modules/remote/protocol.js';
    import { sha256 } from '/modules/remote/identity.js';
    export class RemoteError extends Error { constructor(code) { super(code); this.code = code; } }
    export class RemoteApi {
      constructor() { this.userId = 'review-owner'; this.identity = { endpointId: 'review-controller', jkt: 'review-controller-jkt', rememberHost: async () => {} }; this.keys = { server_instance_id: 'ui-fixture' }; }
      assertCurrent() {}
      async initialize() {
        // Like a fresh sign-in: the first attempt asks for the account password.
        if (!window.__reviewReauthed) { window.__reviewReauthed = true; throw new RemoteError('RD_RECENT_AUTH_REQUIRED'); }
        this.identity.privateKey = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])).privateKey; }
      async request(path, options = {}) {
        if (path.startsWith('/api/v1/rd/grants?')) return { items: [] };
        if (path === '/api/v1/rd/pairings' && options.method === 'POST') {
          const body = options.body;
          this.transcript = { pairing_id: 'review-pairing', server_instance_id: 'ui-fixture', host_endpoint_id: body.host_endpoint_id,
            controller_endpoint_id: this.identity.endpointId, host_jkt: 'review-host-jkt', controller_jkt: this.identity.jkt,
            nonce_controller: body.nonce_controller, nonce_host: 'review-host-nonce', scope: body.permissions, mode: body.mode,
            session_request_id: body.session_request_id, expires_at: new Date(Date.now() + 60000).toISOString() };
          return { id: this.transcript.pairing_id };
        }
        if (path.endsWith('/confirm')) return { state: 'confirmed', grant_id: 'review-grant' };
        if (path === '/api/v1/rd/pairings/review-pairing' && !options.method) {
          const digest = await sha256(canonicalJson(this.transcript));
          const code = Array.from(digest.subarray(0, 16), value => value.toString(16).padStart(2, '0')).join('').match(/.{4}/g).join('-');
          return { id: 'review-pairing', state: 'pending', transcript: this.transcript, display_code: code };
        }
        if (path === '/api/v1/rd/sessions' && options.method === 'POST') return { session_id: 'review-session' };
        if (path === '/api/v1/rd/sessions/review-session' && !options.method) return { session_id: 'review-session', connection_epoch: 1, ticket_jws: 'UI_FIXTURE_ONLY', permissions: this.transcript.scope };
        if (path.endsWith('/close') || path.endsWith('/reject')) return {};
        throw Error('Unmodeled UI fixture request: ' + path);
      }
      close() {}
    }
  ` }));
  await context.route('**/modules/remote/signal.js', route => route.fulfill({ contentType: 'text/javascript', body: 'export class RemoteSignal { async connect() {} close() {} }' }));
  await context.route('**/modules/remote/session.js', route => route.fulfill({ contentType: 'text/javascript', body: `
    import { TYPES } from '/modules/remote/protocol.js';
    import { RemoteError } from '/modules/remote/http.js';
    const declaredState = ${JSON.stringify(item.state)};
    export class RemoteSession {
      constructor(options) {
        Object.assign(this, options); this.id = options.session.session_id; this.epoch = 1;
        this.permissions = new Set(options.session.permissions); this.featureState = new Set(); this.featureRequests = new Map(); this.channels = new Map();
        this.lease = { valid: () => true }; this.ready = false; this.pathVerified = false; this.firstFrameSeen = false; this.inputEnabled = false;
        this.layout = { layout_epoch: 1, active_display: 'main', displays: [{ id: 'main', name: 'Review display 1', width: 1280, height: 720, slot: 0 }, { id: 'secondary', name: 'Review display 2', width: 1920, height: 1080, slot: 1 }] };
        this.remoteCapabilities = { scope: 'UI fixture; no peer or transport' };
        window.reviewSession = this;
      }
      async start() {
        this.onState('connecting');
        if (declaredState === 'connecting') { this.rendered = true; return; }
        if (declaredState === 'waiting_for_frame') { this.pathVerified = true; this.onState('waiting_for_frame'); this.rendered = true; return; }
        if (declaredState === 'failed') { this.fail(new RemoteError('RD_NO_DIRECT_PATH')); this.rendered = true; return; }
        if (declaredState === 'closed') { this.onState('closed'); this.rendered = true; return; }
        const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
        const painter = canvas.getContext('2d'); painter.fillStyle = '#26334d'; painter.fillRect(0, 0, 1280, 720);
        painter.fillStyle = '#edf3ff'; painter.font = '36px sans-serif'; painter.fillText('Home Tunnel UI layout fixture', 60, 110);
        painter.font = '24px sans-serif'; painter.fillText('Local canvas video. No remote computer connected.', 60, 164);
        painter.strokeStyle = '#607999'; for (let x = 60; x < 1250; x += 120) painter.strokeRect(x, 225, 90, 380);
        // A static canvas may emit just its first frame. Subscribe before play.
        const firstFrame = new Promise(done => this.video.requestVideoFrameCallback(done));
        this.stream = canvas.captureStream(1); this.video.srcObject = this.stream;
        await this.video.play(); await firstFrame;
        this.ready = true; this.pathVerified = true; this.firstFrameSeen = true;
        if (declaredState === 'view-only') this.permissions = new Set(['view']);
        this.onState('viewing'); await this.onControl({ type: TYPES.DISPLAY_LAYOUT, payload: this.layout });
        if (declaredState === 'playback') this.onState('playback_gesture_required');
        this.rendered = true;
      }
      requestInput() { this.inputRequested = true; }
      releaseInput() { this.inputEnabled = false; this.inputRequested = false; }
      async setFeature(permission, enabled) { if (enabled) this.featureState.add(permission); else this.featureState.delete(permission); }
      async setSystemAudio(enabled) { await this.setFeature('audio.system', enabled); }
      async startMicrophone() { this.microphone = true; await this.setFeature('audio.microphone', true); }
      async stopMicrophone() { this.microphone = false; }
      async selectDisplay(id) { this.layout.active_display = id; await this.onControl({ type: TYPES.DISPLAY_LAYOUT, payload: this.layout }); }
      async resumePlayback() { this.onState('viewing'); }
      send() { throw Error('UI fixture cannot send remote input'); }
      fail(error) { this.ready = false; this.onState('failed', error); }
      close() { this.stream?.getTracks().forEach(track => track.stop()); this.ready = false; this.releaseInput(); }
    }
  ` }));
  await context.route('**/modules/remote/transfer.js', route => route.fulfill({ contentType: 'text/javascript', body: `
    export class RemoteTransfers {
      constructor(session, callbacks) { this.session = session; Object.assign(this, callbacks); window.reviewTransfers = this; }
      allowed(permission) { return this.session.ready && this.session.permissions.has(permission) && this.session.featureState.has(permission); }
      async offerFiles(files) {
        files.forEach((file, index) => {
          const id = 'review-file-' + index;
          this.onProgress({ id, name: file.name, offered: true, size: file.size });
          this.onProgress({ id, sent: Math.floor(file.size / 2), size: file.size });
        });
      }
      async sendClipboard() {}
      async onFrame() {}
      async revoke() {}
      async cancel() { return { mayBeSaved: false }; }
      clearClipboard() {}
      async close() {}
    }
  ` }));
}

export async function exerciseSessionUi(popup, state) {
  await popup.locator('.remote-auth [name=password]').fill('Review-Only-Password!1234');
  for (const checkbox of await popup.locator('.remote-auth [name=permission]:not(:disabled)').all()) await checkbox.check();
  await popup.locator('.remote-auth button[type=submit]').click();
  await popup.waitForFunction(() => window.reviewSession?.rendered === true);
  if (state === 'input') await popup.locator('[data-release]').click();
  if (state === 'display') await popup.locator('[data-display]').selectOption('secondary');
  if (state === 'audio') await popup.locator('[data-audio]').click();
  if (state === 'clipboard') {
    if (await popup.locator('[data-clipboard-panel]').isHidden()) await popup.locator('[data-clipboard]').click();
    await popup.locator('[data-clipboard-text]').fill('Review text — 中文输入');
    await popup.evaluate(() => window.reviewTransfers.onClipboard('Received UI fixture text — 远端文本'));
  }
  if (state === 'files') {
    await popup.locator('[data-files]').click();
    await popup.locator('[data-file-input]').setInputFiles([
      { name: '家庭备份.txt', mimeType: 'text/plain', buffer: Buffer.alloc(4096, 'a') },
      { name: 'Review document.txt', mimeType: 'text/plain', buffer: Buffer.alloc(8192, 'b') },
    ]);
    await popup.locator('[data-file-send]').click();
    await popup.waitForFunction(() => document.querySelectorAll('.remote-file-row').length === 2);
    await popup.locator('.remote-file-row button').first().click();
    await popup.evaluate(() => window.reviewTransfers.onOffer({ id: 'review-incoming', name: 'Incoming fixture.txt', size: 1024 }));
  }
  if (state === 'diagnostics') await popup.locator('[data-diagnostics-toggle]').click();
  if (state === 'fullscreen') {
    await popup.locator('[data-fullscreen]').click();
    await popup.waitForFunction(() => document.fullscreenElement?.classList.contains('remote-viewer'));
  }
}
