import { RemoteApi, RemoteError } from "./http.js";
import { base64url, sha256, signJws } from "./identity.js";
import { canonicalJson, TYPES } from "./protocol.js";
import { RemoteSignal } from "./signal.js";
import { RemoteSession } from "./session.js";
import { RemoteInput } from "./input.js";
import { RemoteTransfers } from "./transfer.js";

const labels = {
  view: "观看画面", "input.keyboard": "键盘", "input.pointer": "鼠标", "input.text": "中文与文字",
  "audio.system": "系统声音", "audio.microphone": "回传麦克风", "clipboard.read": "读取远端文本剪贴板",
  "clipboard.write": "写入远端文本剪贴板", "files.send": "发送文件", "files.receive": "接收文件",
};
const errors = {
  RD_DISABLED: "服务器未启用远程桌面。", RD_NO_DIRECT_PATH: "当前网络未找到 UDP 直连路径。请检查防火墙、IPv6 或切换网络。",
  RD_BROWSER_LOCKS_UNAVAILABLE: "此浏览器无法安全协调远控身份，请升级浏览器。", RD_IDENTITY_STORAGE_UNAVAILABLE: "无法安全保存浏览器身份，请检查站点存储权限。",
  RD_SERVER_TRUST_CHANGED: "服务器签名身份发生变化。请先核实服务器恢复或密钥更换情况。", RD_FEATURE_DENIED: "被控端未允许该功能。",
  RD_PEER_IDENTITY_MISMATCH: "对端身份验证失败，会话已终止。", RD_MEDIA_FAILED: "画面或媒体连接失败，会话已终止。",
  RD_SESSION_LIMIT: "会话名额已用完，或被控设备正在使用。", RD_PAIRING_EXPIRED: "配对已超时，请在被控设备旁重新发起。",
  RD_CAPTURE_DENIED: "被控设备尚未获得屏幕捕获权限。", RD_INPUT_DENIED: "当前未获得输入权限。",
  RD_TEXT_PENDING: "正在等待上一条文字的确认。", RD_TEXT_REJECTED: "被控端未完成文字输入，请检查远端后再重试。",
  RD_TEXT_UNCONFIRMED: "未收到文字输入确认，远端可能已经输入。请检查远端后再重试。",
  RD_TEXT_CONTROL_TIMEOUT: "文字尚未发送：等待输入授权超时。",
  RD_CLIPBOARD_TEXT_INVALID: "剪贴板文本含有空字符（NUL）或不完整的 Unicode 字符，无法写入远端系统剪贴板。请删除这些字符后重试。",
  RD_ACCESS_INVALID: "设备 ID 或固定密码不正确，或该设备已暂停连接。",
  RD_ACCESS_REJECTED: "被控端拒绝了连接请求。",
  RD_ACCESS_EXPIRED: "连接请求已超时，请重试。",
};
const message = (error) => errors[error?.code ?? error?.message] ?? error?.message ?? "远程桌面操作失败。";
const toolPaths = {
  keyboard: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 13h.01M11 13h.01M15 13h.01M8 16h8"/>',
  release: '<path d="M12 3v8m-5-5a9 9 0 1 0 10 0"/>',
  fullscreen: '<path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6"/>',
  play: '<path d="m8 4 12 8-12 8z"/>',
  audio: '<path d="M4 9h4l5-4v14l-5-4H4zM17 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12"/>',
  microphone: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4m-4 0h8"/>',
  display: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  clipboard: '<rect x="5" y="5" width="14" height="17" rx="2"/><path d="M9 5V3h6v2M8 11h8M8 15h8"/>',
  files: '<path d="M5 3h9l5 5v13H5zM14 3v5h5M8 13h8M8 17h6"/>',
};
const toolIcon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${toolPaths[name]}</svg>`;
export const setToolLabel = (root, selector, label, pressed = false) => { const button = root.querySelector(selector); button.querySelector("span").textContent = label; button.setAttribute("aria-pressed", String(pressed)); };

export function createRemoteView({ api, state, viewContent, escapeHtml }) {
  const active = new Map();
  const pendingClosures = new Set();
  let controller = null, controllerPromise = null, pendingController = null, controllerGeneration = 0, stack = 100;
  const raise = (current) => { current.dialog.style.zIndex = String(++stack); current.dialog.focus(); };
  async function controllerConnection() {
    if (controller) return controller;
    if (controllerPromise) return controllerPromise;
    const generation = controllerGeneration, userId = state.me.id;
    const valid = () => generation === controllerGeneration && state.me?.id === userId;
    const operation = (async () => {
      const context = { api: new RemoteApi(api, userId, valid) }; pendingController = context;
      const locked = await new Promise((resolve, reject) => {
        navigator.locks.request(`rd-controller:${location.origin}:${state.me.id}`, { ifAvailable: true }, async (lock) => {
          if (!lock) { resolve(false); return; }
          await new Promise((release) => { context.unlock = release; resolve(true); });
        }).catch(reject);
      });
      if (!locked) throw new Error("另一个标签页正在使用远程桌面，请先结束那里的会话。");
      try {
        context.api.assertCurrent();
        await context.api.initialize();
        context.signal = new RemoteSignal(context.api, async (message) => {
          for (const current of active.values()) {
            const session = current.session;
            if (!session || session.id !== message.session_id || session.epoch !== message.connection_epoch) continue;
            if (message.payload?.lease_jws && message.payload.lease_seq > session.lease.sequence) session.lease.update(await session.serverClaims(message.payload.lease_jws, "ht-rd-lease+jwt", "ht-rd-use"));
            await session.onSignal(message);
          }
        }, (failure) => {
          const closing = [];
          for (const current of active.values()) if (current.api === context.api) { current.session?.fail(failure); current.showError(failure); if (current.session?.closeRequest) closing.push(current.session.closeRequest); }
          if (controller === context) controller = null;
          context.unlock?.();
          void Promise.allSettled(closing).finally(() => context.api.close());
        });
        await context.signal.connect(); context.api.assertCurrent(); controller = context; return context;
      } catch (error) { context.signal?.close(); context.api?.close(); context.unlock?.(); throw error; }
    })();
    controllerPromise = operation;
    try { return await operation; } finally { if (controllerPromise === operation) { controllerPromise = null; pendingController = null; } }
  }
  async function releaseController() {
    if (active.size || pendingClosures.size) return;
    const context = controller ?? await controllerPromise?.catch(() => null);
    if (active.size || pendingClosures.size || !context) return;
    context.signal?.close(); context.api?.close(); context.unlock?.(); controller = null;
  }
  async function renderRemote(renderId = state.renderId) {
    const capabilities = await api("/api/v1/public/capabilities");
    if (renderId !== state.renderId) return;
    const remote = capabilities.remote_desktop;
    if (!remote?.enabled) {
      viewContent.innerHTML = `<section class="panel empty-state"><h2>远程桌面尚未启用</h2><p>升级并配置支持远程桌面的服务端，然后在被控电脑本机开启该功能。</p><p>现有隧道和 RDP 连接可继续使用。</p></section>`;
      return;
    }
    if (new URLSearchParams(location.search).has("remoteAssist")) {
      document.body.classList.add("remote-popout");
      viewContent.innerHTML = `<section class="panel remote-assist-entry"><h2>连接其他账号的电脑</h2><p>输入对方电脑的 9 位设备 ID。双方需登录同一台服务器。</p><form data-assist-form><label>连接方式<select name="access_mode"><option value="request">发送请求，由被控端批准</option><option value="fixed">固定密码</option><option value="temporary">一次性临时密码</option></select></label><label>设备 ID<input name="device_id" inputmode="numeric" pattern="[0-9]{9}" maxlength="9" autocomplete="off" required></label><label data-assist-password hidden>密码<input name="password" type="password" minlength="1" maxlength="128" autocomplete="off"></label><button class="button button-primary" type="submit">请求连接</button></form><p role="status" data-assist-status></p><p role="alert" data-assist-error></p></section>`;
      const assistForm = viewContent.querySelector("[data-assist-form]");
      const accessMode = assistForm.querySelector('[name="access_mode"]');
      const accessPassword = assistForm.querySelector('[name="password"]');
      const updateAccessMode = () => {
        const needsPassword = accessMode.value !== "request";
        accessPassword.closest("label").hidden = !needsPassword;
        accessPassword.required = needsPassword;
        accessPassword.closest("label").firstChild.textContent = accessMode.value === "fixed" ? "固定密码" : "临时密码";
        assistForm.querySelector("button").textContent = accessMode.value === "request" ? "发送连接请求" : "连接远程设备";
      };
      accessMode.addEventListener("change", updateAccessMode);
      updateAccessMode();
      viewContent.querySelector("[data-assist-form]").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const button = form.querySelector("button");
        button.disabled = true;
        viewContent.querySelector("[data-assist-error]").textContent = "";
        viewContent.querySelector("[data-assist-status]").textContent = "";
        try {
          const values = new FormData(form);
          const context = await controllerConnection();
          const deviceId = values.get("device_id");
          let target;
          if (values.get("access_mode") === "temporary") target = await context.api.request("/api/v1/rd/assist-invites/redeem", { method: "POST", body: { device_id: deviceId, temporary_password: values.get("password") } });
          else if (values.get("access_mode") === "fixed") target = await context.api.request("/api/v1/rd/access/fixed/redeem", { method: "POST", body: { device_id: deviceId, password: values.get("password") } });
          else {
            const request = await context.api.request("/api/v1/rd/access/requests", { method: "POST", body: { device_id: deviceId } });
            viewContent.querySelector("[data-assist-status]").textContent = "已发送请求，等待被控端批准（最多 2 分钟）";
            while (Date.now() < Date.parse(request.expires_at) && document.contains(form)) {
              await new Promise((resolve) => setTimeout(resolve, 1000));
              const decision = await context.api.request(`/api/v1/rd/access/requests/${request.id}`);
              if (decision.state === "approved") { target = decision.target; break; }
              if (decision.state !== "pending") throw new RemoteError("RD_ACCESS_REJECTED");
            }
            if (!target) throw new RemoteError("RD_ACCESS_EXPIRED");
          }
          if (!target.invite_id || !target.host_endpoint_id || !target.host_owner_user_id || !target.host_jkt || !target.host_public_jwk || !Array.isArray(target.capabilities?.displays) || !target.capabilities.displays.length) throw new RemoteError("RD_PROOF_INVALID");
          const host = { id: target.host_endpoint_id, owner_user_id: target.host_owner_user_id, name: target.host_name, platform: "远程设备", jkt: target.host_jkt, public_jwk: target.host_public_jwk, capabilities: target.capabilities, online: true, local_enabled: true };
          form.remove();
          open(host, remote, target.invite_id);
        } catch (error) {
          accessPassword.value = "";
          viewContent.querySelector("[data-assist-error]").textContent = message(error);
        } finally { button.disabled = false; }
      });
      return;
    }
    const result = await api("/api/v1/rd/endpoints?limit=100&offset=0");
    if (renderId !== state.renderId) return;
    const hosts = result.items.filter((endpoint) => endpoint.role !== "controller" && endpoint.status === "active");
    const available = hosts.filter((endpoint) => endpoint.online && endpoint.local_enabled && endpoint.capabilities?.status === "ready" && endpoint.capabilities?.displays?.length);
    const monitor = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></svg>';
    viewContent.innerHTML = `<div class="remote-dashboard"><section class="remote-dashboard-hero"><div><span class="eyebrow">REMOTE DESKTOP</span><h2>像坐在电脑前一样。</h2><p>选择已在线的设备，在独立窗口中查看远程画面。</p></div><button type="button" class="button button-primary" data-remote-browse>查看设备 <span aria-hidden="true">→</span></button></section><div class="remote-dashboard-heading"><h2>可连接设备</h2><span>${available.length} 台在线可连接</span></div><section class="remote-device-grid" id="remote-device-grid">${hosts.map((endpoint) => {
      const ready = endpoint.online && endpoint.local_enabled && endpoint.capabilities?.status === "ready" && endpoint.capabilities?.displays?.length;
      return `<article class="panel remote-device-card"><div class="remote-device-top"><span class="remote-device-icon">${monitor}</span><span class="remote-device-state ${ready ? "ready" : "offline"}">${ready ? "可连接" : "不可连接"}</span></div><h3>${escapeHtml(endpoint.name)}</h3><p>${escapeHtml(endpoint.platform)} · ${ready ? "UDP 直连就绪" : "离线或被控端未就绪"}</p><div class="remote-device-actions"><button class="button button-primary" data-remote-host="${escapeHtml(endpoint.id)}" ${ready ? "" : "disabled"}>立即连接 <span aria-hidden="true">→</span></button>${ready && endpoint.capabilities?.unattended_enabled ? `<button class="button button-secondary" data-remote-trust="${escapeHtml(endpoint.id)}">绑定可信设备</button>` : ""}<details class="remote-device-details"><summary class="button button-secondary">设备信息</summary><div><span>设备标识</span><code>${escapeHtml(endpoint.id)}</code><span>当前状态</span><strong>${endpoint.online ? "在线" : "离线"} · ${endpoint.local_enabled && endpoint.capabilities?.status === "ready" ? "远控已开启" : "远控尚未就绪"}</strong></div></details></div></article>`;
    }).join("") || `<article class="panel empty-state"><h2>还没有被控电脑</h2><p>在桌面客户端本机开启远程桌面后，设备会出现在这里。</p></article>`}</section><section class="remote-unattended-preview"><div><h3>连接其他账号</h3><p>支持被控端批准、固定密码和一次性临时密码。</p></div><button type="button" class="button button-secondary" data-remote-assist>输入设备 ID</button></section><section class="remote-unattended-preview"><div><h3>无人值守</h3><p>${available.some((endpoint) => endpoint.capabilities?.unattended_enabled) ? "可在设备卡片发起可信设备绑定。管理员批准后，在授权有效期内快捷连接。" : "当前没有支持高权限服务的在线设备，可信设备绑定暂不可用。"}</p></div></section></div>`;
    viewContent.querySelector("[data-remote-browse]")?.addEventListener("click", () => viewContent.querySelector("#remote-device-grid")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    viewContent.querySelector("[data-remote-assist]")?.addEventListener("click", () => window.open("/admin?remoteAssist=1#remote", "ht-remote-assist", "width=1280,height=840,resizable=yes,scrollbars=yes,noopener"));
    viewContent.querySelectorAll("[data-remote-host]").forEach((button) => button.addEventListener("click", () => {
      const host = hosts.find((endpoint) => endpoint.id === button.dataset.remoteHost);
      if (host) window.open(`/admin?remoteHost=${encodeURIComponent(host.id)}#remote`, `ht-remote-${host.id}`, "width=1280,height=840,resizable=yes,scrollbars=yes,noopener");
    }));
    viewContent.querySelectorAll("[data-remote-trust]").forEach((button) => button.addEventListener("click", () => {
      const host = hosts.find((endpoint) => endpoint.id === button.dataset.remoteTrust);
      if (host) window.open(`/admin?remoteHost=${encodeURIComponent(host.id)}&remoteTrust=1#remote`, `ht-remote-${host.id}`, "width=1280,height=840,resizable=yes,scrollbars=yes,noopener");
    }));
    const popout = new URLSearchParams(location.search);
    const popoutHostId = popout.get("remoteHost");
    const popoutDeviceId = popout.get("remoteDevice");
    if (popoutHostId || popoutDeviceId) {
      document.body.classList.add("remote-popout");
      const host = hosts.find((endpoint) => popoutHostId ? endpoint.id === popoutHostId : endpoint.linked_device_id === popoutDeviceId);
      if (host && available.includes(host)) open(host, remote, null, popout.get("remoteTrust") === "1" && host.capabilities?.unattended_enabled ? "persistent" : "one_session");
      else viewContent.innerHTML = `<section class="panel empty-state"><h2>设备暂不可用</h2><p>请关闭此窗口，在控制台刷新远控设备列表后重试。</p></section>`;
    }
  }
  function open(host, capabilities, assistInviteId = null, mode = "one_session") {
    if (active.has(host.id)) { raise(active.get(host.id)); return; }
    if (active.size >= 4) return;
    const dialog = document.createElement("dialog"); dialog.className = "remote-dialog";
    dialog.setAttribute("aria-label", `远程桌面：${host.name}`);
    dialog.innerHTML = `<header class="remote-header"><div><h2>${escapeHtml(host.name)}</h2><p class="remote-status" role="status">正在准备安全连接</p></div><button type="button" class="button button-secondary" data-close>关闭</button></header>
      <p class="remote-error" role="alert"></p>
      <form class="remote-auth" hidden><div class="field"><label>账号密码<input name="password" type="password" autocomplete="current-password" required maxlength="256"></label></div><div class="field remote-mfa-field" hidden><label>动态码或恢复码<input name="mfa" autocomplete="one-time-code" maxlength="128"></label></div>
      <fieldset><legend>${assistInviteId ? "画面、键鼠与文本剪贴板随本次连接授权" : mode === "persistent" ? "绑定可信设备需本机管理员批准；持续授权最长 30 天" : "本次请求权限，仍需被控端同意"}</legend>${Object.entries(labels).filter(([permission]) => host.capabilities.permissions?.includes(permission)).map(([permission, label]) => `<label class="remote-permission"><input type="checkbox" name="permission" value="${permission}" ${["view", "input.keyboard", "input.pointer", "input.text", "clipboard.read", "clipboard.write"].includes(permission) ? "checked" : ""} ${permission === "view" ? "disabled" : ""}>${label}</label>`).join("")}</fieldset>
      <button class="button button-primary" type="submit">${mode === "persistent" ? "验证并绑定可信设备" : "验证并请求连接"}</button></form>
      <section class="remote-pairing" hidden><p>${assistInviteId ? "正在验证设备身份与本次连接。" : mode === "persistent" ? "请让被控电脑的管理员确认设备身份并批准持续授权。配对码：" : "请在被控电脑上批准本次连接。配对码用于核对设备身份："}</p><strong class="remote-code" data-no-translate></strong></section>
      <section class="remote-viewer" hidden><div class="remote-toolbar"><button class="button button-secondary" data-input>${toolIcon("keyboard")}<span>允许输入</span></button><button class="button button-secondary" data-release>${toolIcon("release")}<span>释放输入</span></button><button class="button button-secondary" data-fullscreen>${toolIcon("fullscreen")}<span>全屏</span></button><button class="button button-secondary" data-play>${toolIcon("play")}<span>播放画面</span></button><button class="button button-secondary" data-audio ${host.capabilities.permissions?.includes("audio.system") ? "" : "disabled"}>${toolIcon("audio")}<span>开启系统声音</span></button><button class="button button-secondary" data-microphone ${host.capabilities.permissions?.includes("audio.microphone") ? "" : "disabled"}>${toolIcon("microphone")}<span>开启麦克风回传</span></button></div><div class="remote-video-stage"><video class="remote-video" autoplay muted playsinline aria-label="远端桌面"></video><div class="remote-media-mask" data-media-mask>等待身份、直连与画面验证</div></div><form class="remote-text"><label>发送文字（本地完成中文输入）<textarea name="text" rows="2" maxlength="4096"></textarea></label><button class="button button-secondary">发送文字</button></form><details class="remote-viewer-hint"><summary>使用说明</summary><p>退出窗口、失焦或切换页面会释放按键。剪贴板与文件仅在双方启用对应能力后传输。</p></details></section>`;
    const extras = document.createElement("section"); extras.className = "remote-data";
    extras.innerHTML = `<div class="remote-toolbar"><label>${toolIcon("display")}显示器 <select data-display aria-label="远端显示器" disabled></select></label><button class="button button-secondary" data-clipboard>${toolIcon("clipboard")}<span>开启文本剪贴板</span></button><button class="button button-secondary" data-files>${toolIcon("files")}<span>开启文件收发</span></button></div><div data-clipboard-panel hidden><p>剪贴板仅绑定当前指定窗口；浏览器需要前台操作。远端文本收到后，点击“复制到本机”才写入本机剪贴板。</p><label>发送的文本<textarea data-clipboard-text rows="2" maxlength="65536"></textarea></label><button class="button button-secondary" data-clipboard-read>读取本机剪贴板</button><button class="button button-secondary" data-clipboard-send>发送文本剪贴板</button><label>远端文本<textarea data-clipboard-incoming readonly rows="2"></textarea></label><button class="button button-secondary" data-clipboard-copy>复制到本机</button></div><div data-file-panel hidden><input type="file" data-file-input multiple aria-label="选择要发送的文件"><button class="button button-secondary" data-file-send>发送所选文件</button><p data-file-support></p><div data-file-list aria-live="polite"></div></div><details><summary>连接诊断</summary><pre data-diagnostics>等待身份与直连验证</pre></details>`;
    dialog.querySelector(".remote-viewer").append(extras);
    for (const selector of ["[data-audio]", "[data-microphone]", "[data-clipboard]", "[data-files]"]) dialog.querySelector(selector).setAttribute("aria-pressed", "false");
    const primaryToolbar = dialog.querySelector(".remote-viewer > .remote-toolbar");
    const dataToolbar = extras.querySelector(".remote-toolbar");
    primaryToolbar.append(...dataToolbar.children);
    dataToolbar.remove();
    document.body.append(dialog); dialog.show();
    const current = { dialog, mode, disposed: false, pollTimer: null, pairing: null, api: null, signal: null, session: null, input: null, abort: new AbortController(), rows: new Map(), pending: new Set() };
    const track = (promise) => {
      current.pending.add(promise);
      void promise.then(() => current.pending.delete(promise), () => current.pending.delete(promise));
      return promise;
    };
    const syncControls = () => {
      const session = current.session;
      const visible = !!session?.ready && session.pathVerified && session.firstFrameSeen;
      const allowed = (...permissions) => visible && permissions.some((permission) => session.permissions.has(permission));
      dialog.querySelector("[data-media-mask]").hidden = !!visible;
      dialog.querySelector("[data-display]").disabled = !visible || session.layout?.displays.length < 2;
      const input = allowed("input.keyboard", "input.pointer", "input.text");
      for (const selector of ["[data-input]", "[data-release]"]) dialog.querySelector(selector).disabled = !input;
      for (const [selector, permissions] of [
        ["[data-audio]", ["audio.system"]], ["[data-microphone]", ["audio.microphone"]],
        ["[data-clipboard]", ["clipboard.read", "clipboard.write"]], ["[data-files]", ["files.send", "files.receive"]],
        ["[data-file-send]", ["files.send"]], ["[data-file-input]", ["files.send"]],
        ["[data-clipboard-send]", ["clipboard.write"]], ["[data-clipboard-read]", ["clipboard.write"]],
        ["[data-clipboard-copy]", ["clipboard.read"]], [".remote-text button", ["input.text"]], [".remote-text textarea", ["input.text"]],
      ]) dialog.querySelector(selector).disabled = !allowed(...permissions);
      if (current.pendingText !== undefined || current.textSending) {
        dialog.querySelector(".remote-text button").disabled = true;
        dialog.querySelector("[data-input]").disabled = true;
      }
    };
    syncControls();
    active.set(host.id, current); raise(current);
    const switcher = document.createElement("button"); switcher.className = "button remote-window-switch"; switcher.textContent = host.name;
    let windowBar = document.querySelector(".remote-window-bar");
    if (!windowBar) { windowBar = document.createElement("nav"); windowBar.className = "remote-window-bar"; windowBar.setAttribute("aria-label", "远程桌面窗口"); document.body.append(windowBar); }
    windowBar.append(switcher); switcher.addEventListener("click", () => raise(current));
    dialog.addEventListener("pointerdown", () => { dialog.style.zIndex = String(++stack); });
    const status = dialog.querySelector(".remote-status"), error = dialog.querySelector(".remote-error");
    const showError = (value) => { if (!current.disposed) error.textContent = message(value); };
    current.showError = showError;
    const resumeInput = () => {
      const session = current.session;
      if (current.disposed || current.manualInputRelease || document.hidden || !document.hasFocus() ||
        !session?.ready || !session.pathVerified || !session.firstFrameSeen || !session.video.videoWidth ||
        session.inputEnabled || session.inputRequested ||
        !["input.keyboard", "input.pointer", "input.text"].some((permission) => session.permissions.has(permission))) return;
      try { session.requestInput(); } catch (failure) { showError(failure); }
    };
    window.addEventListener("focus", resumeInput, { signal: current.abort.signal });
    document.addEventListener("visibilitychange", resumeInput, { signal: current.abort.signal });
    const close = () => {
      if (current.disposed) return;
      current.disposed = true; current.abort.abort(); clearTimeout(current.pollTimer); clearTimeout(current.textRequestTimer); current.input?.close(); void current.transfers?.close(); current.session?.close();
      active.delete(host.id); switcher.remove(); if (!active.size) windowBar.remove();
      const cleanup = (async () => {
        await Promise.allSettled([...current.pending]);
        await Promise.allSettled([
          current.session?.closeRequest,
          !current.session && current.snapshot?.session_id && current.api?.request(`/api/v1/rd/sessions/${current.snapshot.session_id}/close`, { method: "POST", body: {} }),
          current.pairing?.id && current.api?.request(`/api/v1/rd/pairings/${current.pairing.id}/reject`, { method: "POST", body: {} }),
        ].filter(Boolean));
      })();
      pendingClosures.add(cleanup);
      void cleanup.finally(() => {
        pendingClosures.delete(cleanup);
        void releaseController();
        if (document.body.classList.contains("remote-popout") && !active.size) {
          window.close();
          document.body.classList.remove("remote-popout");
        }
      });
      dialog.close(); dialog.remove();
    };
    current.close = close;
    dialog.querySelector("[data-close]").addEventListener("click", close);
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
    const safe = (callback) => (event) => { event?.preventDefault(); Promise.resolve().then(() => callback(event)).catch(showError); };
    const form = dialog.querySelector(".remote-auth");
    async function startConnection(values) {
      if (current.starting || current.disposed) return;
      current.starting = true;
      const submit = form.querySelector("button"); submit.disabled = true; error.textContent = "";
      try {
        if (!navigator.locks) throw new RemoteError("RD_BROWSER_LOCKS_UNAVAILABLE");
        if (values) await api("/api/v1/rd/reauth", { method: "POST", body: JSON.stringify({ password: values.get("password"), ...(values.get("mfa") ? { mfa_code: values.get("mfa") } : {}) }) });
        if (current.disposed) return;
        const context = await controllerConnection(); current.api = context.api; current.signal = context.signal;
        if (current.disposed) { void releaseController(); return; }
        const selected = values ?? new FormData(form);
        current.permissions = ["view", ...selected.getAll("permission").filter((permission) => permission !== "view")];
        current.requestId = crypto.randomUUID(); current.nonce = base64url(crypto.getRandomValues(new Uint8Array(32)));
        if (!values && !assistInviteId && mode === "one_session" && host.owner_user_id && host.owner_user_id === current.api.userId) {
          const grants = await current.api.request("/api/v1/rd/grants?limit=100&offset=0");
          const trusted = grants.items?.find((grant) => grant.status === "active" && grant.mode === "persistent" && grant.host_endpoint_id === host.id && grant.controller_endpoint_id === current.api.identity.endpointId && Date.parse(grant.expires_at) > Date.now() && Array.isArray(grant.permissions) && grant.permissions.includes("view"));
          if (trusted) {
            current.permissions = ["view", ...["input.keyboard", "input.pointer", "input.text", "clipboard.read", "clipboard.write"].filter((permission) => trusted.permissions.includes(permission) && host.capabilities.permissions?.includes(permission))];
            current.snapshot = await current.api.request("/api/v1/rd/sessions", { method: "POST", idempotencyKey: current.requestId, body: { host_endpoint_id: host.id, grant_id: trusted.id, permissions: current.permissions, display_id: host.capabilities.displays[0].id, protocol: { major: 1, minor: 0 }, quality: "balanced" } });
            if (current.disposed) { await current.api.request(`/api/v1/rd/sessions/${current.snapshot.session_id}/close`, { method: "POST", body: {} }); return; }
            status.textContent = "正在连接可信设备";
            await pollSession();
            return;
          }
        }
        current.pairing = await current.api.request("/api/v1/rd/pairings", { method: "POST", body: { host_endpoint_id: host.id, session_request_id: current.requestId, permissions: current.permissions, mode, nonce_controller: current.nonce, ...(assistInviteId ? { assist_invite_id: assistInviteId } : {}) } });
        if (current.disposed) { await current.api.request(`/api/v1/rd/pairings/${current.pairing.id}/reject`, { method: "POST", body: {} }); return; }
        form.hidden = true; dialog.querySelector(".remote-pairing").hidden = false;
        status.textContent = assistInviteId ? "正在验证跨账号连接" : "等待被控电脑本机批准";
        await pollPairing();
      } finally { current.starting = false; submit.disabled = false; }
    }
    form.addEventListener("submit", safe(async () => {
      try { await track(startConnection(new FormData(form))); }
      catch (failure) {
        if (failure?.code === "MFA_REQUIRED" || failure?.code === "MFA_INVALID") {
          form.querySelector(".remote-mfa-field").hidden = false;
          status.textContent = failure.code === "MFA_REQUIRED" ? "请输入动态码或恢复码" : "动态码无效，请重试";
          form.querySelector('[name="mfa"]').focus();
          return;
        }
        form.querySelector('[name="password"]').value = "";
        throw failure;
      } finally { form.querySelector('[name="mfa"]').value = ""; }
    }));
    async function pollPairing() {
      if (current.disposed) return;
      const pairing = await current.api.request(`/api/v1/rd/pairings/${current.pairing.id}`);
      if (current.disposed) return;
      if (pairing.state !== "pending") throw new RemoteError("RD_PAIRING_EXPIRED");
      const proof = pairing.transcript;
      if (proof.host_endpoint_id !== host.id || proof.host_jkt !== host.jkt || proof.controller_endpoint_id !== current.api.identity.endpointId || proof.controller_jkt !== current.api.identity.jkt || proof.nonce_controller !== current.nonce || proof.server_instance_id !== current.api.keys.server_instance_id || proof.session_request_id !== current.requestId || proof.mode !== mode || canonicalJson(proof.scope) !== canonicalJson(current.permissions)) throw new RemoteError("RD_PROOF_INVALID");
      if (assistInviteId ? proof.assist_invite_id !== assistInviteId || proof.host_owner_user_id !== host.owner_user_id || proof.controller_owner_user_id !== current.api.userId : proof.assist_invite_id) throw new RemoteError("RD_PROOF_INVALID");
      current.pairing = pairing;
      if (proof.nonce_host) {
        const hash = await sha256(canonicalJson(proof));
        const code = Array.from(hash.subarray(0, 16), (n) => n.toString(16).padStart(2, "0")).join("").match(/.{4}/g).join("-");
        if (pairing.display_code !== code) throw new RemoteError("RD_PROOF_INVALID");
        dialog.querySelector(".remote-code").textContent = code;
        status.textContent = "本机已批准，正在建立安全连接";
        await completePairing();
      } else current.pollTimer = setTimeout(() => track(pollPairing()).catch(showError), 1000);
    }
    async function completePairing() {
      if (current.completingPairing || current.disposed) return;
      current.completingPairing = true;
      const pairing = await current.api.request(`/api/v1/rd/pairings/${current.pairing.id}/confirm`, { method: "POST", body: { signed_proof: await signJws(current.api.identity, current.pairing.transcript, "ht-rd-pairing+jwt") } });
      if (current.disposed) return;
      if (pairing.state !== "confirmed" || !pairing.grant_id) throw new RemoteError("RD_PAIRING_REQUIRED");
      if (mode === "persistent") current.pairing = null;
      current.snapshot = await current.api.request("/api/v1/rd/sessions", { method: "POST", idempotencyKey: current.requestId, body: { host_endpoint_id: host.id, grant_id: pairing.grant_id, permissions: current.permissions, display_id: host.capabilities.displays[0].id, protocol: { major: 1, minor: 0 }, quality: "balanced" } });
      if (current.disposed) { await current.api.request(`/api/v1/rd/sessions/${current.snapshot.session_id}/close`, { method: "POST", body: {} }); return; }
      dialog.querySelector(".remote-pairing").hidden = true; status.textContent = "正在连接远程设备";
      await pollSession();
    }
    async function pollSession() {
      if (current.disposed) return;
      const snapshot = await current.api.request(`/api/v1/rd/sessions/${current.snapshot.session_id}`);
      if (current.disposed) return;
      if (["failed", "expired", "closed", "closing"].includes(snapshot.state)) throw new RemoteError(snapshot.close_reason ?? "RD_SESSION_REVOKED");
      if (!snapshot.ticket_jws) { current.pollTimer = setTimeout(() => track(pollSession()).catch(showError), 1000); return; }
      dialog.querySelector(".remote-viewer").hidden = false;
      const video = dialog.querySelector("video");
      current.session = new RemoteSession({ api: current.api, signal: current.signal, session: snapshot, hostThumbprint: host.jkt, hostOwnerUserId: host.owner_user_id ?? current.api.userId, video,
        onState: (phase, failure) => {
          syncControls();
          status.textContent = { connecting: "正在检查直连", waiting_for_frame: "身份和直连已验证，等待画面", viewing: "被控端已验证 UDP 直连 · 只看画面", switching_display: "正在切换显示器，等待新画面", closed: "会话已结束", failed: "会话失败", playback_gesture_required: "请点击播放画面" }[phase] ?? phase;
          if (phase === "viewing") {
            current.retries = 0;
            resumeInput();
            if (!current.clipboardRequested && ["clipboard.read", "clipboard.write"].some((permission) => current.session.permissions.has(permission))) {
              current.clipboardRequested = true;
              void navigator.locks.request(`rd-clipboard:${location.origin}`, async () => {
                if (current.disposed || !current.session?.ready || document.hidden) return;
                for (const other of active.values()) if (other !== current && other.session) {
                  await Promise.all(["clipboard.read", "clipboard.write"].filter((permission) => other.session.featureState.has(permission)).map((permission) => other.session.setFeature(permission, false)));
                  other.dialog.querySelector("[data-clipboard-panel]").hidden = true;
                  setToolLabel(other.dialog, "[data-clipboard]", "开启文本剪贴板");
                }
                await setFeatures(["clipboard.read", "clipboard.write"], true);
                dialog.querySelector("[data-clipboard-panel]").hidden = false;
                setToolLabel(dialog, "[data-clipboard]", "关闭文本剪贴板", true);
              }).catch(showError);
            }
            if (!current.hostRemembered) {
              current.hostRemembered = true;
              void current.api.identity.rememberHost(host.id, host.jkt).catch(showError);
            }
          }
          if (phase !== "viewing") dialog.querySelector("[data-media-mask]").textContent = status.textContent;
          if (failure) showError(failure);
          if (["closed", "failed"].includes(phase)) { void current.transfers?.close(); current.pendingText = undefined; clearTimeout(current.textRequestTimer); dialog.querySelector("[data-clipboard-incoming]").value = ""; }
        },
        onControl: async (frame) => {
          if (frame.type === TYPES.INPUT_SYNC_ACK) {
            if (current.pendingText !== undefined) {
              const text = current.pendingText, input = current.input;
              current.pendingText = undefined; current.textSending = true; clearTimeout(current.textRequestTimer); syncControls();
              void (async () => {
                try {
                  await input.submitTextOnce(text);
                  if (!current.disposed && input === current.input) {
                    const field = dialog.querySelector(".remote-text textarea");
                    if (field.value === text) field.value = "";
                    status.textContent = "被控端已确认文字输入";
                  }
                } catch (failure) { if (!current.disposed && input === current.input) showError(failure); }
                finally {
                  if (input === current.input) { current.textSending = false; syncControls(); }
                }
              })();
            } else { video.focus(); status.textContent = "被控端已验证 UDP 直连 · 允许输入"; }
          }
          if (frame.type === TYPES.DISPLAY_LAYOUT) {
            const select = dialog.querySelector("[data-display]"); select.replaceChildren();
            for (const display of frame.payload.displays) { const option = document.createElement("option"); option.value = display.id; option.textContent = display.name ?? display.id; select.append(option); }
            select.value = frame.payload.active_display; select.disabled = frame.payload.displays.length < 2;
          }
          if (frame.type === TYPES.FEATURE_STATE && !frame.payload.enabled) await current.transfers?.revoke(frame.payload.permission);
          if (frame.type === TYPES.FEATURE_STATE && frame.payload.enabled && frame.payload.permission.startsWith("clipboard.") && !current.transfers?.canUseClipboard()) pauseClipboard();
          await current.transfers?.onFrame(frame);
          syncControls();
          const session = current.session;
          dialog.querySelector("[data-diagnostics]").textContent = JSON.stringify({ connectionEpoch: session.epoch, hostVerifiedUDP: session.pathVerified, browserVerifiedUDP: session.selectedPair?.verified ?? false, activeDisplay: session.layout?.active_display, capabilities: session.remoteCapabilities }, null, 2);
        },
        onReconnectNeeded: (reason, displayId) => reconnect(reason, displayId).catch(showError),
        onFeatureRevoked: (permission) => {
          void current.transfers?.revoke(permission);
          if (permission === "audio.system") setToolLabel(dialog, "[data-audio]", "开启系统声音");
          if (permission === "audio.microphone") setToolLabel(dialog, "[data-microphone]", "开启麦克风回传");
          if (permission.startsWith("clipboard.")) {
            dialog.querySelector("[data-clipboard-panel]").hidden = true;
            setToolLabel(dialog, "[data-clipboard]", "开启文本剪贴板");
            dialog.querySelector("[data-clipboard-incoming]").value = "";
            dialog.querySelector("[data-clipboard-text]").value = "";
          }
          if (permission.startsWith("files.")) {
            dialog.querySelector("[data-file-panel]").hidden = true;
            setToolLabel(dialog, "[data-files]", "开启文件收发");
          }
        },
      });
      current.input = new RemoteInput(current.session, video);
      current.transfers = new RemoteTransfers(current.session, { onOffer: offerFile, onProgress: fileProgress, onClipboard: (text) => { dialog.querySelector("[data-clipboard-incoming]").value = text; }, canUseClipboard: () => !document.hidden && document.hasFocus() && dialog.contains(document.activeElement) });
      try { await current.session.start(capabilities.stun_urls); } catch (failure) { current.session.fail(failure); throw failure; }
    }
    async function reconnect(reason, displayId) {
      if (current.disposed || current.reconnecting || !current.session) return;
      const previous = current.session;
      if ((reason !== "display_changed" && (current.retries ?? 0) >= 3) || !previous.lease.valid()) { previous.fail(new RemoteError("RD_NO_DIRECT_PATH")); return; }
      current.reconnecting = true; if (reason !== "display_changed") current.retries = (current.retries ?? 0) + 1;
      current.input?.close(); previous.close({ remote: false }); void current.transfers?.close(); current.session = null;
      current.inputRequested = false; current.clipboardRequested = false;
      current.pendingText = undefined; clearTimeout(current.textRequestTimer);
      syncControls();
      status.textContent = reason === "display_changed" ? "正在切换显示器，等待本机批准和新画面" : "正在恢复直连，输入和麦克风已暂停";
      dialog.querySelector("[data-media-mask]").textContent = status.textContent;
      try {
        current.snapshot = await current.api.request(`/api/v1/rd/sessions/${previous.id}/reconnect`, { method: "POST", idempotencyKey: crypto.randomUUID(), body: { expected_epoch: previous.epoch, reason, ...(displayId !== undefined ? { display_id: displayId } : {}) } });
        if (!current.disposed) await pollSession();
      } catch (failure) {
        void current.api.request(`/api/v1/rd/sessions/${previous.id}/close`, { method: "POST", body: {} }).catch(() => {});
        throw failure;
      } finally { current.reconnecting = false; }
    }
    dialog.querySelector("[data-input]").addEventListener("click", safe(() => { current.manualInputRelease = false; current.session?.requestInput(); }));
    dialog.querySelector("[data-release]").addEventListener("click", () => { current.manualInputRelease = true; current.pendingText = undefined; clearTimeout(current.textRequestTimer); current.input?.release(); syncControls(); status.textContent = "只看画面 · 输入已释放"; });
    dialog.querySelector("[data-fullscreen]").addEventListener("click", safe(() => dialog.querySelector(".remote-viewer").requestFullscreen()));
    dialog.querySelector("[data-play]").addEventListener("click", safe(() => current.session?.resumePlayback()));
    dialog.querySelector("[data-audio]").addEventListener("click", safe(async () => { const enabled = !current.session.featureState.has("audio.system"); await current.session.setSystemAudio(enabled); setToolLabel(dialog, "[data-audio]", enabled ? "关闭系统声音" : "开启系统声音", enabled); }));
    dialog.querySelector("[data-microphone]").addEventListener("click", safe(() => navigator.locks.request(`rd-microphone:${location.origin}`, async () => { if (current.disposed || !current.session?.ready) throw new RemoteError("RD_MEDIA_FAILED"); if (current.session.microphone) { await current.session.stopMicrophone(); await current.session.setFeature("audio.microphone", false); } else { for (const other of active.values()) if (other !== current && other.session?.microphone) { await other.session.stopMicrophone(); await other.session.setFeature("audio.microphone", false); setToolLabel(other.dialog, "[data-microphone]", "开启麦克风回传"); } await current.session.startMicrophone(); } setToolLabel(dialog, "[data-microphone]", current.session.microphone ? "关闭麦克风回传" : "开启麦克风回传", !!current.session.microphone); })));
    dialog.querySelector(".remote-text").addEventListener("submit", safe(() => {
      if (current.pendingText !== undefined || current.textSending) throw new RemoteError("RD_TEXT_PENDING");
      current.pendingText = dialog.querySelector(".remote-text textarea").value;
      try {
        current.session.requestInput(); syncControls();
        current.textRequestTimer = setTimeout(() => {
          if (current.disposed || current.pendingText === undefined) return;
          current.pendingText = undefined; current.session.releaseInput(); syncControls(); showError(new RemoteError("RD_TEXT_CONTROL_TIMEOUT"));
        }, 5000);
      }
      catch (failure) { current.pendingText = undefined; throw failure; }
    }));
    dialog.querySelector("[data-display]").addEventListener("change", safe((event) => current.session.selectDisplay(event.target.value)));
    const setFeatures = async (permissions, enabled) => {
      const supported = permissions.filter((permission) => current.session?.permissions.has(permission)), changed = [];
      if (!supported.length) throw new RemoteError("RD_SCOPE_DENIED");
      try {
        if (!enabled) { await Promise.all(supported.map((permission) => current.session.setFeature(permission, false))); return; }
        for (const permission of supported) { await current.session.setFeature(permission, true); changed.push(permission); }
      } catch (failure) {
        if (enabled) for (const permission of changed) { current.session.featureState.delete(permission); await current.transfers.revoke(permission); await current.session.setFeature(permission, false).catch(() => {}); }
        throw failure;
      }
    };
    dialog.querySelector("[data-clipboard]").addEventListener("click", safe(() => navigator.locks.request(`rd-clipboard:${location.origin}`, async () => {
      if (current.disposed || !current.session?.ready) throw new RemoteError("RD_MEDIA_FAILED");
      const panel = dialog.querySelector("[data-clipboard-panel]"), enabled = panel.hidden;
      if (enabled) for (const other of active.values()) if (other !== current && other.session) {
        await Promise.all(["clipboard.read", "clipboard.write"].filter((permission) => other.session.featureState.has(permission) || other.session.featureRequests.has(permission)).map((permission) => other.session.setFeature(permission, false)));
        other.dialog.querySelector("[data-clipboard-panel]").hidden = true; setToolLabel(other.dialog, "[data-clipboard]", "开启文本剪贴板");
      }
      await setFeatures(["clipboard.read", "clipboard.write"], enabled); panel.hidden = !enabled;
      setToolLabel(dialog, "[data-clipboard]", enabled ? "关闭文本剪贴板" : "开启文本剪贴板", enabled);
    })));
    dialog.querySelector("[data-clipboard-read]").addEventListener("click", safe(async () => {
      if (!current.transfers?.allowed("clipboard.write") || !navigator.clipboard?.readText) throw new Error("浏览器不支持此操作或当前窗口未获得权限，请手动粘贴文本。");
      const text = await navigator.clipboard.readText();
      if (!current.transfers.allowed("clipboard.write")) return;
      if (new TextEncoder().encode(text).length > 65536) throw new Error("剪贴板文本超过 64 KiB。");
      dialog.querySelector("[data-clipboard-text]").value = text;
    }));
    dialog.querySelector("[data-clipboard-send]").addEventListener("click", safe(() => current.transfers.sendClipboard(dialog.querySelector("[data-clipboard-text]").value)));
    dialog.querySelector("[data-clipboard-copy]").addEventListener("click", safe(() => {
      if (!current.transfers?.allowed("clipboard.read") || !navigator.clipboard?.writeText) throw new Error("浏览器不支持此操作或当前窗口未获得权限，请手动复制文本。");
      return navigator.clipboard.writeText(dialog.querySelector("[data-clipboard-incoming]").value);
    }));
    function pauseClipboard() {
      current.transfers?.clearClipboard(); dialog.querySelector("[data-clipboard-incoming]").value = ""; dialog.querySelector("[data-clipboard-text]").value = "";
      dialog.querySelector("[data-clipboard-panel]").hidden = true; setToolLabel(dialog, "[data-clipboard]", "开启文本剪贴板");
      for (const permission of ["clipboard.read", "clipboard.write"]) if (current.session?.featureState.has(permission) || current.session?.featureRequests.get(permission)?.enabled) {
        void current.session.setFeature(permission, false).catch(() => {});
      }
    }
    dialog.addEventListener("focusout", (event) => { if (!dialog.contains(event.relatedTarget)) pauseClipboard(); });
    document.addEventListener("visibilitychange", () => { if (document.hidden) pauseClipboard(); }, { signal: current.abort.signal });
    window.addEventListener("blur", pauseClipboard, { signal: current.abort.signal });
    dialog.querySelector("[data-file-support]").textContent = typeof window.showSaveFilePicker === "function" ? "收到文件后请选择保存位置。浏览器确认覆盖已有文件时，请检查文件名。" : "此浏览器不支持流式保存文件，接收功能不可用；请使用支持文件保存选择器的浏览器或桌面客户端。";
    dialog.querySelector("[data-files]").addEventListener("click", safe(async () => {
      const panel = dialog.querySelector("[data-file-panel]"), enabled = panel.hidden;
      await setFeatures(["files.send", ...(typeof window.showSaveFilePicker === "function" ? ["files.receive"] : [])], enabled);
      panel.hidden = !enabled; setToolLabel(dialog, "[data-files]", enabled ? "关闭文件收发" : "开启文件收发", enabled);
    }));
    dialog.querySelector("[data-file-send]").addEventListener("click", safe(async () => { const input = dialog.querySelector("[data-file-input]"); await current.transfers.offerFiles([...input.files]); input.value = ""; }));
    function fileRow(id, name) {
      if (current.rows.has(id)) return current.rows.get(id);
      if (current.rows.size >= 128) { const oldest = current.rows.keys().next().value; current.rows.get(oldest).row.remove(); current.rows.delete(oldest); }
      const row = document.createElement("div"), text = document.createElement("span"), cancel = document.createElement("button"); row.className = "remote-file-row"; text.textContent = name ?? id;
      cancel.className = "button button-secondary"; cancel.textContent = "取消"; cancel.addEventListener("click", safe(async () => { const result = await current.transfers.cancel(id); text.textContent = result.mayBeSaved ? "已停止传输；保存可能已完成，请检查接收位置" : "已停止传输"; cancel.disabled = true; }));
      row.append(text, cancel); dialog.querySelector("[data-file-list]").append(row);
      const entry = { row, text, cancel }; current.rows.set(id, entry); return entry;
    }
    function fileProgress(progress) {
      if (current.disposed) return;
      const row = fileRow(progress.id, progress.name);
      if (progress.complete || progress.error) { row.text.textContent = progress.complete ? "校验完成，文件已保存" : progress.mayBeSaved ? "已停止传输；保存可能已完成，请检查接收位置" : message(new Error(progress.error)); row.cancel.disabled = true; }
      else if (!progress.offered) row.text.textContent = `${progress.received ?? progress.sent ?? 0} / ${progress.size} 字节`;
    }
    function offerFile(offer) {
      const row = fileRow(offer.id, offer.name), accept = document.createElement("button"); accept.className = "button button-secondary"; accept.textContent = "选择保存位置";
      accept.addEventListener("click", safe(async () => {
        if (!current.transfers.allowed("files.receive") || typeof window.showSaveFilePicker !== "function") throw new Error("当前无法接收文件。");
        const handle = await window.showSaveFilePicker({ suggestedName: offer.name });
        const sink = await handle.createWritable({ keepExistingData: false });
        try { await current.transfers.acceptFile(offer.id, sink); accept.remove(); } catch (failure) { await sink.abort().catch(() => {}); throw failure; }
      })); row.row.append(accept);
    }
    if (mode === "persistent") { form.hidden = false; status.textContent = "先验证账号，再请本机管理员绑定可信设备"; return; }
    void track(startConnection()).catch((failure) => {
      if (current.disposed) return;
      form.hidden = false;
      status.textContent = failure?.code === "RD_RECENT_AUTH_REQUIRED" ? "首次使用需验证账号" : "请验证账号后重试连接";
      if (failure?.code !== "RD_RECENT_AUTH_REQUIRED") showError(failure);
    });
  }
  return { renderRemote, closeRemote: () => {
    controllerGeneration++;
    for (const current of [...active.values()]) current.close();
    for (const context of [controller, pendingController]) { context?.signal?.close(); context?.api?.close(); context?.unlock?.(); }
    controller = null; controllerPromise = null; pendingController = null;
  } };
}
