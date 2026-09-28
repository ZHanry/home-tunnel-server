import { RemoteApi, RemoteError } from "./http.js";
import { base64url, sha256, signJws } from "./identity.js";
import { canonicalJson, TYPES } from "./protocol.js";
import { RemoteSignal } from "./signal.js";
import { RemoteSession } from "./session.js";
import { RemoteInput } from "./input.js";
import { RemoteTransfers } from "./transfer.js";

const labels = {
  view: "观看画面", "input.keyboard": "键盘", "input.pointer": "鼠标", "input.text": "文字输入（含中文）",
  "audio.system": "系统声音", "audio.microphone": "麦克风", "clipboard.read": "复制远端文字",
  "clipboard.write": "粘贴到远端", "files.send": "发送文件", "files.receive": "接收文件",
};
const errors = {
  RD_DISABLED: "服务器未启用远程桌面。", RD_NO_DIRECT_PATH: "无法连接到对方设备。请确认对方在线后重试，或切换网络。",
  RD_BROWSER_LOCKS_UNAVAILABLE: "此浏览器无法安全协调远控身份，请升级浏览器。", RD_IDENTITY_STORAGE_UNAVAILABLE: "无法安全保存浏览器身份，请检查站点存储权限。",
  RD_SERVER_TRUST_CHANGED: "服务器签名身份发生变化。请先核实服务器恢复或密钥更换情况。", RD_FEATURE_DENIED: "被控端未允许该功能。",
  RD_PEER_IDENTITY_MISMATCH: "对端身份验证失败，会话已终止。", RD_MEDIA_FAILED: "画面或媒体连接失败，会话已终止。",
  RD_SESSION_LIMIT: "会话名额已用完，或被控设备正在使用。", RD_PAIRING_EXPIRED: "配对已超时，请在被控设备旁重新发起。",
  RD_CAPTURE_DENIED: "被控设备尚未获得屏幕捕获权限。", RD_INPUT_DENIED: "当前未获得输入权限。",
  RD_TEXT_PENDING: "正在等待上一条文字的确认。", RD_TEXT_REJECTED: "被控端未完成文字输入，请检查远端后再重试。",
  RD_TEXT_UNCONFIRMED: "未收到文字输入确认，远端可能已经输入。请检查远端后再重试。",
  RD_TEXT_CONTROL_TIMEOUT: "文字尚未发送：等待输入授权超时。",
  RD_CLIPBOARD_TEXT_INVALID: "剪贴板文本含有空字符（NUL）或不完整的 Unicode 字符，无法写入远端系统剪贴板。请删除这些字符后重试。",
  RD_ACCESS_INVALID: "设备 ID 或连接凭据无效，或该设备已暂停连接。",
  RD_DEVICE_ID_FORMAT: "设备 ID 应为 9 位数字。",
  RD_ACCESS_REJECTED: "被控端拒绝了连接请求。",
  RD_ACCESS_EXPIRED: "连接请求已超时，请重试。",
};
const message = (error) => errors[error?.code ?? error?.message] ?? error?.message ?? "远程桌面操作失败。";
// One stroke icon set (24px grid, currentColor) for the whole viewer.
const toolPaths = {
  input: '<path d="M5.5 3.5 18.5 10l-5.8 1.9-2.3 6.1z"/><path d="m12.8 12.1 4.7 4.7"/>',
  release: '<path d="M5.5 3.5 18.5 10l-5.8 1.9-2.3 6.1z"/><path d="M3 21 21 3"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6.5 10h1M10.5 10h1M14.5 10h1M6.5 14h11"/>',
  more: '<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>',
  fullscreen: '<path d="M8.5 4H4v4.5M15.5 4H20v4.5M4 15.5V20h4.5M20 15.5V20h-4.5"/>',
  play: '<circle cx="12" cy="12" r="9"/><path d="m10 8.5 5 3.5-5 3.5z"/>',
  audio: '<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10"/>',
  microphone: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  display: '<rect x="3" y="4" width="18" height="12.5" rx="2"/><path d="M8.5 20.5h7M12 16.5v4"/>',
  clipboard: '<rect x="5" y="4.5" width="14" height="16.5" rx="2"/><path d="M9 4.5V3h6v1.5M8.5 10.5h7M8.5 14.5h5"/>',
  files: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/><path d="M12 11v5m-2.5-2.5L12 16l2.5-2.5"/>',
  text: '<path d="M5 7V5h14v2M12 5v14m-3 0h6"/>',
  diagnostics: '<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>',
  disconnect: '<path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
};
const toolIcon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${toolPaths[name]}</svg>`;
// Icon-only tool: the first hidden span carries the (translatable) label that setToolLabel updates;
// the second one says why a disabled tool is unavailable and is appended to the tooltip.
const tool = (hook, icon, label, extra = "") => `<button type="button" class="remote-tool" ${hook} ${extra} aria-label="${label}" title="${label}">${toolIcon(icon)}<span class="visually-hidden">${label}</span><span class="visually-hidden" data-reason></span></button>`;
export const setToolLabel = (root, selector, label, pressed = false) => { const button = root.querySelector(selector); button.querySelector("span").textContent = label; button.setAttribute("aria-pressed", String(pressed)); };
const disabledReasons = { idle: "连接后可用", scope: "被控端未授权此功能", control: "请先开始控制" };
const setToolDisabled = (button, reason) => {
  button.disabled = !!reason;
  const span = button.querySelector("[data-reason]");
  if (span && span.dataset.key !== (reason || "")) { span.dataset.key = reason || ""; span.textContent = reason ? disabledReasons[reason] : ""; }
};
// Windows shortcuts the browser itself would swallow. Ctrl+Alt+Del is a secure attention
// sequence that only the OS can raise, so it is deliberately absent.
const shortcuts = [
  ["开始菜单", "Win", ["MetaLeft"]], ["切换窗口", "Alt+Tab", ["AltLeft", "Tab"]], ["任务视图", "Win+Tab", ["MetaLeft", "Tab"]],
  ["显示桌面", "Win+D", ["MetaLeft", "KeyD"]], ["文件资源管理器", "Win+E", ["MetaLeft", "KeyE"]], ["运行", "Win+R", ["MetaLeft", "KeyR"]],
  ["任务管理器", "Ctrl+Shift+Esc", ["ControlLeft", "ShiftLeft", "Escape"]], ["关闭当前程序", "Alt+F4", ["AltLeft", "F4"]], ["截图", "PrtSc", ["PrintScreen"]],
];

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
      viewContent.innerHTML = `<section class="panel remote-assist-entry"><h2>连接其他账号的电脑</h2><p>输入对方电脑的 9 位设备 ID。双方需登录同一台服务器。</p><form data-assist-form><label>连接方式<select name="access_mode"><option value="request">发送请求，由被控端批准</option><option value="fixed">固定密码</option><option value="temporary">一次性临时密码</option></select></label><label>设备 ID<input name="device_id" inputmode="numeric" maxlength="15" placeholder="123 456 789" autocomplete="off" spellcheck="false" required></label><label data-assist-password hidden>密码<input name="password" type="password" minlength="1" maxlength="128" autocomplete="off"></label><button class="button button-primary" type="submit">请求连接</button></form><p role="status" data-assist-status></p><p role="alert" data-assist-error></p></section>`;
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
      // The desktop client opens this window with the ID the user already typed.
      const prefilledId = (new URLSearchParams(location.search).get("remoteAccessId") || "").replace(/[\s-]/g, "");
      if (/^[0-9]{9}$/.test(prefilledId)) assistForm.querySelector('[name="device_id"]').value = prefilledId.replace(/(\d{3})(?=\d)/g, "$1 ");
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
          // Spaces and dashes only group the digits for reading.
          const deviceId = String(values.get("device_id") || "").replace(/[\s-]/g, "");
          if (!/^[0-9]{9}$/.test(deviceId)) throw new RemoteError("RD_DEVICE_ID_FORMAT");
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
      return `<article class="panel remote-device-card"><div class="remote-device-top"><span class="remote-device-icon">${monitor}</span><span class="remote-device-state ${ready ? "ready" : "offline"}">${ready ? "可连接" : "不可连接"}</span></div><h3 data-no-translate>${escapeHtml(endpoint.name)}</h3><p>${escapeHtml(endpoint.platform)} · ${ready ? "可远程控制" : "离线或被控端未就绪"}</p><div class="remote-device-actions"><button class="button button-primary" data-remote-host="${escapeHtml(endpoint.id)}" ${ready ? "" : "disabled"}>立即连接 <span aria-hidden="true">→</span></button><details class="remote-device-details"><summary class="button button-secondary">设备信息</summary><div><span>设备标识</span><code>${escapeHtml(endpoint.id)}</code><span>当前状态</span><strong>${endpoint.online ? "在线" : "离线"} · ${endpoint.local_enabled && endpoint.capabilities?.status === "ready" ? "远控已开启" : "远控尚未就绪"}</strong></div></details></div></article>`;
    }).join("") || `<article class="panel empty-state"><h2>还没有被控电脑</h2><p>在桌面客户端本机开启远程桌面后，设备会出现在这里。</p></article>`}</section><section class="remote-assist-preview"><div><h3>连接其他账号</h3><p>支持被控端批准、固定密码（可用于无人值守）和一次性临时密码。</p></div><button type="button" class="button button-secondary" data-remote-assist>输入设备 ID</button></section></div>`;
    viewContent.querySelector("[data-remote-browse]")?.addEventListener("click", () => viewContent.querySelector("#remote-device-grid")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    viewContent.querySelector("[data-remote-assist]")?.addEventListener("click", () => window.open("/admin?remoteAssist=1#remote", "ht-remote-assist", "width=1280,height=840,resizable=yes,scrollbars=yes,noopener"));
    viewContent.querySelectorAll("[data-remote-host]").forEach((button) => button.addEventListener("click", () => {
      const host = hosts.find((endpoint) => endpoint.id === button.dataset.remoteHost);
      if (host) window.open(`/admin?remoteHost=${encodeURIComponent(host.id)}#remote`, `ht-remote-${host.id}`, "width=1280,height=840,resizable=yes,scrollbars=yes,noopener");
    }));
    const popout = new URLSearchParams(location.search);
    const popoutHostId = popout.get("remoteHost");
    const popoutDeviceId = popout.get("remoteDevice");
    if (popoutHostId || popoutDeviceId) {
      document.body.classList.add("remote-popout");
      const host = hosts.find((endpoint) => popoutHostId ? endpoint.id === popoutHostId : endpoint.linked_device_id === popoutDeviceId);
      if (host && available.includes(host)) open(host, remote);
      else viewContent.innerHTML = `<section class="panel empty-state"><h2>设备暂不可用</h2><p>请关闭此窗口，在控制台刷新远控设备列表后重试。</p></section>`;
    }
  }
  // Like mainstream remote tools, a connection asks for files and system audio too; the host
  // still sees the full list before approving. The microphone stays opt-in.
  const defaultPermissions = ["view", "input.keyboard", "input.pointer", "input.text", "clipboard.read", "clipboard.write", "files.send", "files.receive", "audio.system"];
  // A device-ID connection is pre-approved by the host. 9.x hosts pre-approve only screen, input
  // and clipboard and would hold anything more for a click nobody makes when unattended. Only
  // 10.x hosts report transports (udp_relay), and they pre-approve files and system audio too.
  const narrowPermissions = ["view", "input.keyboard", "input.pointer", "input.text", "clipboard.read", "clipboard.write"];
  const connectionDefaults = (host, assistInviteId) => assistInviteId && !host.capabilities.transports?.includes("udp_relay") ? narrowPermissions : defaultPermissions;
  function open(host, capabilities, assistInviteId = null, mode = "one_session") {
    if (active.has(host.id)) { raise(active.get(host.id)); return; }
    if (active.size >= 4) return;
    const dialog = document.createElement("dialog"); dialog.className = "remote-dialog";
    // The desktop client and console open the viewer in its own window, which has an OS close button.
    const popoutWindow = document.body.classList.contains("remote-popout");
    const microphonePermitted = !!host.capabilities.permissions?.includes("audio.microphone");
    dialog.innerHTML = `${popoutWindow ? "" : `<button type="button" class="remote-close" data-close aria-label="关闭远程桌面" title="关闭远程桌面">${toolIcon("close")}</button>`}<div class="remote-card"><header class="remote-header"><span class="remote-badge" aria-hidden="true">${toolIcon("display")}</span><div class="remote-identity"><h2>${escapeHtml(host.name)}</h2><p class="remote-status" role="status">正在准备安全连接</p></div><span class="remote-latency" data-no-translate hidden></span></header>
      <p class="remote-error" role="alert"></p>
      <form class="remote-auth" hidden><div class="field"><label>当前账号的登录密码<input name="password" placeholder="用于确认是你本人" type="password" autocomplete="current-password" required maxlength="256"></label></div><div class="field remote-mfa-field" hidden><label>动态码或恢复码<input name="mfa" autocomplete="one-time-code" maxlength="128"></label></div>
      <fieldset><legend>${assistInviteId ? (connectionDefaults(host, assistInviteId) === narrowPermissions ? "画面、键鼠与文本剪贴板随本次连接授权" : "画面、键鼠、剪贴板、文件与声音随本次连接授权") : mode === "persistent" ? "绑定可信设备需本机管理员批准；持续授权最长 30 天" : "本次请求权限，仍需被控端同意"}</legend>${Object.entries(labels).filter(([permission]) => host.capabilities.permissions?.includes(permission)).map(([permission, label]) => `<label class="remote-permission"><input type="checkbox" name="permission" value="${permission}" ${connectionDefaults(host, assistInviteId).includes(permission) ? "checked" : ""} ${permission === "view" ? "disabled" : ""}>${label}</label>`).join("")}</fieldset>
      <button class="button button-primary" type="submit">${mode === "persistent" ? "验证并绑定可信设备" : "验证并请求连接"}</button></form>
      <section class="remote-pairing" hidden><p>${assistInviteId ? "正在验证设备身份与本次连接。" : mode === "persistent" ? "请让被控电脑的管理员确认设备身份并批准持续授权。配对码：" : "请在被控电脑上批准本次连接。配对码用于核对设备身份："}</p><strong class="remote-code" data-no-translate></strong></section>
      <div class="remote-card-actions"><button type="button" class="button button-secondary" data-cancel>取消</button></div></div>
      <section class="remote-viewer" hidden><div class="remote-toolbar"><div class="remote-tools" role="group" aria-label="远程控制工具">
        ${tool("data-input", "input", "开始控制")}${tool("data-release", "release", "停止控制", "hidden")}<label class="remote-display-picker" title="显示器">${toolIcon("display")}<span class="visually-hidden">显示器</span><select data-display aria-label="远端显示器" disabled></select></label>${tool("data-fullscreen", "fullscreen", "全屏")}<span class="remote-tool-divider" aria-hidden="true"></span>
        ${tool("data-clipboard", "clipboard", "剪贴板", 'aria-expanded="false"')}${tool("data-files", "files", "文件传输", 'aria-expanded="false"')}${tool("data-text-toggle", "text", "发送文字", 'aria-expanded="false"')}${tool("data-shortcuts", "keyboard", "快捷键", 'aria-haspopup="menu" aria-expanded="false"')}<span class="remote-tool-divider" aria-hidden="true"></span>
        ${tool("data-audio", "audio", "开启系统声音", host.capabilities.permissions?.includes("audio.system") ? "" : "disabled")}${tool("data-microphone", "microphone", "开启麦克风回传", microphonePermitted ? "" : "disabled hidden")}${tool("data-play", "play", "播放画面", "hidden")}${tool("data-more", "more", "更多", 'aria-haspopup="menu" aria-expanded="false"')}
      </div><button type="button" class="remote-disconnect" data-disconnect title="断开连接">${toolIcon("disconnect")}<span>断开</span></button></div>
      <div class="remote-menu" role="menu" data-shortcut-menu hidden aria-label="发送快捷键">${shortcuts.map(([name, keys], index) => `<button type="button" role="menuitem" class="remote-menu-item" data-shortcut="${index}"><span>${name}</span><kbd data-no-translate>${keys}</kbd></button>`).join("")}<p class="remote-menu-note">Ctrl+Alt+Del 与锁屏、UAC 窗口受 Windows 保护，无法远程发送。</p></div>
      <div class="remote-menu" role="menu" data-more-menu hidden aria-label="更多"><button type="button" role="menuitemcheckbox" aria-checked="false" class="remote-menu-item" data-diagnostics-toggle><span>连接诊断</span></button><button type="button" role="menuitem" class="remote-menu-item" data-toolbar-hide><span>收起工具栏</span></button></div>
      <div class="remote-video-stage"><video class="remote-video" autoplay muted playsinline aria-label="远端桌面"></video><div class="remote-media-mask" data-media-mask>正在建立安全连接</div>
      <p class="remote-toast" role="status" aria-live="polite" hidden></p>
      <section class="remote-data" aria-label="连接工具面板"><div class="remote-panel" data-clipboard-panel hidden><h3>剪贴板</h3><p class="remote-panel-note" data-clipboard-note>已开启双向同步：在本机复制后回到远程画面即可粘贴；远端复制的文字会自动写入本机剪贴板。</p><div class="remote-panel-actions"><button type="button" class="button button-secondary" data-clipboard-pause>暂停同步</button></div><label>手动发给远端<textarea data-clipboard-text rows="2" placeholder="输入或粘贴要发给远端的文字" maxlength="65536"></textarea></label><div class="remote-panel-actions"><button type="button" class="button button-secondary" data-clipboard-read>粘贴本机内容</button><button type="button" class="button button-primary" data-clipboard-send>发送</button></div><label>最近来自远端<textarea data-clipboard-incoming readonly rows="2" placeholder="远端复制文字后会显示在这里"></textarea></label><div class="remote-panel-actions"><button type="button" class="button button-secondary" data-clipboard-copy>复制到本机</button></div></div>
        <div class="remote-panel" data-file-panel hidden><h3>文件传输</h3><input type="file" data-file-input multiple aria-label="选择要发送的文件"><div class="remote-panel-actions"><button type="button" class="button button-primary" data-file-send>发送所选文件</button></div><p class="remote-panel-note" data-file-support></p><div class="remote-file-list" data-file-list aria-live="polite"></div></div>
        <form class="remote-panel remote-text" data-text-panel hidden><h3>发送文字</h3><label>在这里输入，完成后发送到远端光标处<textarea name="text" rows="3" maxlength="4096"></textarea></label><div class="remote-panel-actions"><button class="button button-primary">发送文字</button></div></form>
        <div class="remote-panel" data-diagnostics-panel hidden><h3>连接诊断</h3><pre data-diagnostics>正在建立安全连接</pre></div></section></div></section>`;
    const title = dialog.querySelector("h2"); title.id = `remote-title-${crypto.randomUUID()}`; title.dataset.noTranslate = "";
    dialog.setAttribute("aria-labelledby", title.id);
    for (const selector of ["[data-audio]", "[data-microphone]"]) dialog.querySelector(selector).setAttribute("aria-pressed", "false");
    // Icon-only tools expose their (translated) hidden label as aria-label, and the tooltip
    // adds why a disabled tool is unavailable.
    const mirrorToolLabels = () => {
      for (const button of dialog.querySelectorAll(".remote-tool")) {
        const label = button.querySelector("span").textContent, reason = button.querySelector("[data-reason]").textContent;
        const title = reason ? `${label} · ${reason}` : label;
        if (button.getAttribute("aria-label") !== label) button.setAttribute("aria-label", label);
        if (button.title !== title) button.title = title;
      }
    };
    new MutationObserver(mirrorToolLabels).observe(dialog.querySelector(".remote-tools"), { subtree: true, childList: true, characterData: true });
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
      // Once the viewer is shown, the host name/status joins the top bar and errors float over the screen.
      const viewer = dialog.querySelector(".remote-viewer");
      if (!viewer.hidden && !dialog.classList.contains("remote-connected")) {
        dialog.classList.add("remote-connected");
        viewer.querySelector(".remote-toolbar").prepend(dialog.querySelector(".remote-header"));
        viewer.querySelector(".remote-video-stage").append(dialog.querySelector(".remote-error"));
        const closeButton = dialog.querySelector("[data-close]");
        if (closeButton) viewer.querySelector(".remote-toolbar").append(closeButton);
      }
      dialog.dataset.live = String(!!visible);
      const mask = dialog.querySelector("[data-media-mask]");
      mask.hidden = !!visible && !current.needsGesture; mask.dataset.gesture = String(!!current.needsGesture);
      dialog.querySelector("[data-play]").hidden = !current.needsGesture;
      dialog.querySelector("[data-display]").disabled = !visible || session.layout?.displays.length < 2;
      // Why a tool is unavailable: not connected yet, or the host did not grant the permission.
      const reason = (...permissions) => !visible ? "idle" : permissions.some((permission) => session.permissions.has(permission)) ? "" : "scope";
      // One control toggle, like mainstream remote tools: "start control" or "stop control".
      const inputReason = reason("input.keyboard", "input.pointer", "input.text");
      const controlling = !inputReason && !!(session.inputEnabled || session.inputRequested);
      for (const selector of ["[data-input]", "[data-release]"]) setToolDisabled(dialog.querySelector(selector), inputReason);
      dialog.querySelector("[data-input]").hidden = controlling;
      dialog.querySelector("[data-release]").hidden = !controlling;
      for (const [selector, permissions] of [
        ["[data-audio]", ["audio.system"]], ["[data-microphone]", ["audio.microphone"]],
        ["[data-clipboard]", ["clipboard.read", "clipboard.write"]], ["[data-files]", ["files.send", "files.receive"]], ["[data-text-toggle]", ["input.text"]],
      ]) setToolDisabled(dialog.querySelector(selector), reason(...permissions));
      setToolDisabled(dialog.querySelector("[data-shortcuts]"), reason("input.keyboard") || (session.inputEnabled ? "" : "control"));
      for (const [selector, permissions] of [
        ["[data-file-send]", ["files.send"]], ["[data-file-input]", ["files.send"]],
        ["[data-clipboard-send]", ["clipboard.write"]], ["[data-clipboard-read]", ["clipboard.write"]], ["[data-clipboard-pause]", ["clipboard.read", "clipboard.write"]],
        ["[data-clipboard-copy]", ["clipboard.read"]], [".remote-text button", ["input.text"]], [".remote-text textarea", ["input.text"]],
      ]) dialog.querySelector(selector).disabled = !allowed(...permissions);
      if (dialog.querySelector("[data-shortcuts]").disabled) closeMenus();
      if (current.pendingText !== undefined || current.textSending) {
        dialog.querySelector(".remote-text button").disabled = true;
        dialog.querySelector("[data-input]").disabled = true;
      }
    };
    function closeMenus() {
      for (const [menu, button] of [["[data-shortcut-menu]", "[data-shortcuts]"], ["[data-more-menu]", "[data-more]"]]) {
        const element = dialog.querySelector(menu); if (element.hidden) continue;
        element.hidden = true; dialog.querySelector(button).setAttribute("aria-expanded", "false");
      }
    }
    syncControls();
    active.set(host.id, current); raise(current);
    const switcher = document.createElement("button"); switcher.className = "button remote-window-switch"; switcher.textContent = host.name;
    switcher.dataset.noTranslate = "";
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
    // Round-trip time of the connected path, shown next to the host name like other remote tools.
    current.latencyTimer = setInterval(async () => {
      const session = current.session, badge = dialog.querySelector(".remote-latency");
      let rtt;
      try {
        const stats = session?.pc && dialog.dataset.live === "true" ? await session.pc.getStats() : null;
        stats?.forEach((entry) => { if (entry.type === "transport" && entry.selectedCandidatePairId) rtt = stats.get(entry.selectedCandidatePairId)?.currentRoundTripTime; });
      } catch {}
      badge.hidden = !Number.isFinite(rtt);
      if (Number.isFinite(rtt)) badge.textContent = `${Math.max(1, Math.round(rtt * 1000))} ms`;
    }, 2000);
    document.addEventListener("visibilitychange", resumeInput, { signal: current.abort.signal });
    const close = () => {
      if (current.disposed) return;
      current.disposed = true; current.abort.abort(); clearTimeout(current.pollTimer); clearInterval(current.latencyTimer); clearTimeout(current.textRequestTimer); current.input?.close(); void current.transfers?.close(); current.session?.close();
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
    for (const selector of ["[data-close]", "[data-cancel]", "[data-disconnect]"]) dialog.querySelector(selector)?.addEventListener("click", close);
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
    const safe = (callback) => (event) => { event?.preventDefault(); Promise.resolve().then(() => callback(event)).catch(showError); };
    const form = dialog.querySelector(".remote-auth");
    error.id = `remote-error-${crypto.randomUUID()}`;
    form.setAttribute("aria-describedby", error.id);
    async function startConnection(values) {
      if (current.starting || current.disposed) return;
      current.starting = true;
      const submit = form.querySelector("button"); submit.disabled = true; error.textContent = "";
      form.setAttribute("aria-busy", "true");
      if (values) status.textContent = "正在验证账号";
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
            current.permissions = ["view", ...defaultPermissions.filter((permission) => permission !== "view" && trusted.permissions.includes(permission) && host.capabilities.permissions?.includes(permission))];
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
      } finally { current.starting = false; submit.disabled = false; form.setAttribute("aria-busy", "false"); }
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
        status.textContent = "请验证账号后重试连接";
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
          status.textContent = { connecting: "正在连接", waiting_for_frame: "已连接，等待画面", viewing: "已连接 · 仅查看", switching_display: "正在切换显示器，等待新画面", closed: "会话已结束", failed: "会话失败", playback_gesture_required: "点击画面开始播放" }[phase] ?? phase;
          if (phase === "playback_gesture_required") { current.needsGesture = true; syncControls(); }
          if (phase === "viewing") {
            current.retries = 0; current.needsGesture = false; syncControls();
            resumeInput();
            // Clipboard sync starts silently in the background; the panel is only a fallback.
            void resumeClipboard();
            if (!current.hostRemembered) {
              current.hostRemembered = true;
              void current.api.identity.rememberHost(host.id, host.jkt).catch(showError);
            }
          }
          if (phase !== "viewing") dialog.querySelector("[data-media-mask]").textContent = status.textContent;
          if (failure) showError(failure);
          if (["closed", "failed"].includes(phase)) { current.needsGesture = false; closeMenus(); void current.transfers?.close(); current.pendingText = undefined; clearTimeout(current.textRequestTimer); dialog.querySelector("[data-clipboard-incoming]").value = ""; }
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
            } else { video.focus(); status.textContent = "已连接 · 可控制"; }
          }
          if (frame.type === TYPES.DISPLAY_LAYOUT) {
            const select = dialog.querySelector("[data-display]"); select.replaceChildren();
            for (const display of frame.payload.displays) { const option = document.createElement("option"); option.dataset.noTranslate = ""; option.value = display.id; option.textContent = display.name ?? display.id; select.append(option); }
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
            current.clipboardRequested = false;
            dialog.querySelector("[data-clipboard-incoming]").value = "";
            dialog.querySelector("[data-clipboard-text]").value = "";
          }
          if (permission.startsWith("files.")) { current.filesEnabled = null; if (!transferring()) showPanel("[data-file-panel]", false); }
        },
      });
      current.input = new RemoteInput(current.session, video);
      current.transfers = new RemoteTransfers(current.session, { onOffer: offerFile, onProgress: fileProgress, onClipboard: (text) => receiveClipboard(text), canUseClipboard: () => !document.hidden && document.hasFocus() && dialog.contains(document.activeElement) });
      try { await current.session.start(capabilities.stun_urls); } catch (failure) { current.session.fail(failure); throw failure; }
    }
    async function reconnect(reason, displayId) {
      if (current.disposed || current.reconnecting || !current.session) return;
      const previous = current.session;
      if ((reason !== "display_changed" && (current.retries ?? 0) >= 3) || !previous.lease.valid()) { previous.fail(new RemoteError("RD_NO_DIRECT_PATH")); return; }
      current.reconnecting = true; if (reason !== "display_changed") current.retries = (current.retries ?? 0) + 1;
      current.input?.close(); previous.close({ remote: false }); void current.transfers?.close(); current.session = null;
      current.inputRequested = false; current.clipboardRequested = false; current.filesEnabled = null; current.needsGesture = false;
      current.pendingText = undefined; clearTimeout(current.textRequestTimer);
      syncControls();
      status.textContent = reason === "display_changed" ? "正在切换显示器，等待本机批准和新画面" : "网络波动，正在重新连接";
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
    dialog.querySelector("[data-release]").addEventListener("click", () => { current.manualInputRelease = true; current.pendingText = undefined; clearTimeout(current.textRequestTimer); current.input?.release(); syncControls(); status.textContent = "已停止控制 · 仅查看画面"; });
    dialog.querySelector("[data-fullscreen]").addEventListener("click", safe(() => document.fullscreenElement === dialog.querySelector(".remote-viewer") ? document.exitFullscreen() : dialog.querySelector(".remote-viewer").requestFullscreen()));
    // Full screen shows the toolbar briefly, then collapses it to a small handle (hover or focus reveals it).
    document.addEventListener("fullscreenchange", () => {
      const viewer = dialog.querySelector(".remote-viewer"), entered = document.fullscreenElement === viewer;
      setToolLabel(dialog, "[data-fullscreen]", entered ? "退出全屏" : "全屏", entered);
      clearTimeout(current.peekTimer);
      if (entered) { viewer.dataset.peek = ""; current.peekTimer = setTimeout(() => delete viewer.dataset.peek, 2500); } else delete viewer.dataset.peek;
    }, { signal: current.abort.signal });
    // Drawers: one button each, closed by the same button or by clicking the remote screen.
    const panelToggles = { "[data-clipboard-panel]": "[data-clipboard]", "[data-file-panel]": "[data-files]", "[data-text-panel]": "[data-text-toggle]", "[data-diagnostics-panel]": "[data-diagnostics-toggle]" };
    const showPanel = (panelSelector, open) => {
      dialog.querySelector(panelSelector).hidden = !open;
      const toggle = dialog.querySelector(panelToggles[panelSelector]);
      toggle.setAttribute(toggle.getAttribute("role") === "menuitemcheckbox" ? "aria-checked" : "aria-expanded", String(open));
    };
    const togglePanel = (panelSelector, before, focusSelector) => dialog.querySelector(panelToggles[panelSelector]).addEventListener("click", safe(async () => {
      const open = dialog.querySelector(panelSelector).hidden;
      closeMenus();
      if (open && before) await before();
      showPanel(panelSelector, open);
      if (open && focusSelector) dialog.querySelector(panelSelector).querySelector(focusSelector)?.focus();
    }));
    togglePanel("[data-text-panel]", null, "textarea");
    togglePanel("[data-diagnostics-panel]");
    togglePanel("[data-clipboard-panel]");
    togglePanel("[data-file-panel]", () => enableFiles());
    const transferring = () => [...current.rows.values()].some((entry) => !entry.cancel.disabled);
    dialog.querySelector(".remote-video-stage").addEventListener("pointerdown", (event) => {
      if (event.target.closest(".remote-data, .remote-toast")) return;
      for (const panelSelector of Object.keys(panelToggles)) if (!dialog.querySelector(panelSelector).hidden && !(panelSelector === "[data-file-panel]" && transferring())) showPanel(panelSelector, false);
    });
    // Menus (shortcuts, more) drop down under their toolbar button.
    const menus = { "[data-shortcut-menu]": "[data-shortcuts]", "[data-more-menu]": "[data-more]" };
    for (const [menuSelector, buttonSelector] of Object.entries(menus)) {
      const button = dialog.querySelector(buttonSelector), menu = dialog.querySelector(menuSelector);
      button.addEventListener("click", () => {
        const open = menu.hidden; closeMenus(); if (!open) return;
        const viewer = dialog.querySelector(".remote-viewer").getBoundingClientRect(), anchor = button.getBoundingClientRect();
        menu.hidden = false; button.setAttribute("aria-expanded", "true");
        menu.style.top = `${anchor.bottom - viewer.top + 8}px`;
        menu.style.left = `${Math.max(8, Math.min(anchor.left - viewer.left, viewer.width - menu.offsetWidth - 8))}px`;
        menu.querySelector("button:not(:disabled)")?.focus();
      });
      menu.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); closeMenus(); button.focus(); } });
    }
    document.addEventListener("pointerdown", (event) => { if (!event.target.closest?.(".remote-menu, [data-shortcuts], [data-more]")) closeMenus(); }, { signal: current.abort.signal });
    dialog.querySelector("[data-shortcut-menu]").addEventListener("click", safe((event) => {
      const item = event.target.closest("[data-shortcut]"); if (!item) return;
      closeMenus(); dialog.querySelector("video").focus();
      current.input?.combo(shortcuts[Number(item.dataset.shortcut)][2]);
    }));
    // The toolbar can be tucked away to a small tab; hovering or clicking the tab brings it back.
    const viewerElement = dialog.querySelector(".remote-viewer");
    dialog.querySelector("[data-toolbar-hide]").addEventListener("click", () => { closeMenus(); viewerElement.dataset.collapsed = ""; dialog.querySelector("video").focus(); });
    dialog.querySelector(".remote-toolbar").addEventListener("click", (event) => { if ("collapsed" in viewerElement.dataset && event.target === event.currentTarget) delete viewerElement.dataset.collapsed; });
    const resumePlayback = safe(async () => { await current.session?.resumePlayback(); current.needsGesture = false; syncControls(); });
    dialog.querySelector("[data-play]").addEventListener("click", resumePlayback);
    dialog.querySelector("[data-media-mask]").addEventListener("click", (event) => { if (current.needsGesture) resumePlayback(event); });
    dialog.querySelector("[data-audio]").addEventListener("click", safe(async () => { const enabled = !current.session.featureState.has("audio.system"); await current.session.setSystemAudio(enabled); setToolLabel(dialog, "[data-audio]", enabled ? "关闭系统声音" : "开启系统声音", enabled); }));
    dialog.querySelector("[data-microphone]").addEventListener("click", safe(() => navigator.locks.request(`rd-microphone:${location.origin}`, async () => { if (current.disposed || !current.session?.ready) throw new RemoteError("RD_MEDIA_FAILED"); if (current.session.microphone) { await current.session.stopMicrophone(); await current.session.setFeature("audio.microphone", false); } else { for (const other of active.values()) if (other !== current && other.session?.microphone) { await other.session.stopMicrophone(); await other.session.setFeature("audio.microphone", false); setToolLabel(other.dialog, "[data-microphone]", "开启麦克风回传"); } await current.session.startMicrophone(); } setToolLabel(dialog, "[data-microphone]", current.session.microphone ? "关闭麦克风回传" : "开启麦克风回传", !!current.session.microphone); })));
    dialog.querySelector(".remote-text").addEventListener("submit", safe(() => {
      if (current.pendingText !== undefined || current.textSending) throw new RemoteError("RD_TEXT_PENDING");
      const field = dialog.querySelector(".remote-text textarea");
      if (current.session.inputEnabled) {
        // Already in control: send directly and keep control afterwards.
        const text = field.value, input = current.input;
        current.textSending = true; syncControls();
        void input.submitText(text).then(() => {
          if (current.disposed || input !== current.input) return;
          if (field.value === text) field.value = "";
          status.textContent = "被控端已确认文字输入";
        }, (failure) => { if (!current.disposed && input === current.input) showError(failure); })
          .finally(() => { if (input === current.input) { current.textSending = false; syncControls(); } });
        return;
      }
      current.pendingText = field.value;
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
    // Text clipboard syncs both ways while this window has focus, like mainstream remote tools.
    // Leaving the window pauses it (the host only receives what the user copies here).
    const clipboardNote = (text) => { dialog.querySelector("[data-clipboard-note]").textContent = text; };
    async function resumeClipboard() {
      const session = current.session;
      if (current.disposed || current.clipboardUserPaused || current.clipboardRequested || !session?.ready || document.hidden || !document.hasFocus() ||
        !["clipboard.read", "clipboard.write"].some((permission) => session.permissions.has(permission))) return;
      current.clipboardRequested = true;
      try {
        await navigator.locks.request(`rd-clipboard:${location.origin}`, async () => {
          if (current.disposed || current.session !== session || !session.ready || document.hidden) return;
          for (const other of active.values()) if (other !== current && other.session) {
            await Promise.all(["clipboard.read", "clipboard.write"].filter((permission) => other.session.featureState.has(permission) || other.session.featureRequests.has(permission)).map((permission) => other.session.setFeature(permission, false)));
            other.clipboardRequested = false;
          }
          // A pause that is still being acknowledged must settle before re-enabling.
          for (const permission of ["clipboard.read", "clipboard.write"]) await session.featureRequests.get(permission)?.promise.catch(() => {});
          const wanted = ["clipboard.read", "clipboard.write"].filter((permission) => !session.featureState.has(permission));
          if (wanted.length) await setFeatures(wanted, true);
        });
        if (current.session === session) { clipboardNote("已开启双向同步：在本机复制后回到远程画面即可粘贴；远端复制的文字会自动写入本机剪贴板。"); void pushLocalClipboard(); }
      } catch (failure) {
        if (current.session === session) { current.clipboardRequested = false; clipboardNote("剪贴板同步未开启，可在下方手动收发文字。"); }
        if (failure?.code !== "RD_SCOPE_DENIED") showError(failure);
      }
    }
    // Sends what the user copied on this computer, once per change.
    async function pushLocalClipboard() {
      if (current.pushingClipboard || current.clipboardReadDenied || !current.transfers?.allowed("clipboard.write") || !navigator.clipboard?.readText) return;
      current.pushingClipboard = true;
      try {
        const permission = await navigator.permissions?.query({ name: "clipboard-read" }).catch(() => null);
        if (permission?.state === "denied") { current.clipboardReadDenied = true; return; }
        const text = await navigator.clipboard.readText();
        if (!text || text === current.lastClipboardText || new TextEncoder().encode(text).length > 65536 || !current.transfers?.allowed("clipboard.write")) return;
        await current.transfers.sendClipboard(text); current.lastClipboardText = text;
      } catch (failure) { if (failure?.name === "NotAllowedError") current.clipboardReadDenied = true; }
      finally { current.pushingClipboard = false; }
    }
    async function receiveClipboard(text) {
      dialog.querySelector("[data-clipboard-incoming]").value = text; current.lastClipboardText = text;
      try {
        if (!document.hasFocus() || !navigator.clipboard?.writeText) throw new Error("unavailable");
        await navigator.clipboard.writeText(text);
      } catch { toast("远端复制了文字，打开剪贴板面板可复制到本机"); }
    }
    function toast(text) {
      const note = dialog.querySelector(".remote-toast"); note.textContent = text; note.hidden = false;
      clearTimeout(current.toastTimer); current.toastTimer = setTimeout(() => { note.hidden = true; }, 3500);
    }
    dialog.querySelector("[data-clipboard-pause]").addEventListener("click", safe(async () => {
      current.clipboardUserPaused = !current.clipboardUserPaused;
      dialog.querySelector("[data-clipboard-pause]").textContent = current.clipboardUserPaused ? "恢复同步" : "暂停同步";
      if (current.clipboardUserPaused) { pauseClipboard(); clipboardNote("同步已暂停，可在下方手动收发文字。"); } else await resumeClipboard();
    }));
    const enableFiles = async () => {
      if (current.filesEnabled === current.session) return;
      await setFeatures(["files.send", ...(typeof window.showSaveFilePicker === "function" ? ["files.receive"] : [])], true);
      current.filesEnabled = current.session;
    };
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
      current.clipboardRequested = false;
      for (const permission of ["clipboard.read", "clipboard.write"]) if (current.session?.featureState.has(permission) || current.session?.featureRequests.get(permission)?.enabled) {
        void current.session.setFeature(permission, false).catch(() => {});
      }
    }
    dialog.addEventListener("focusout", (event) => { if (!dialog.contains(event.relatedTarget)) pauseClipboard(); });
    document.addEventListener("visibilitychange", () => { if (document.hidden) pauseClipboard(); else void resumeClipboard(); }, { signal: current.abort.signal });
    window.addEventListener("blur", pauseClipboard, { signal: current.abort.signal });
    window.addEventListener("focus", () => { if (!dialog.contains(document.activeElement) && !dialog.querySelector(".remote-viewer").hidden) dialog.querySelector("video").focus(); void resumeClipboard(); }, { signal: current.abort.signal });
    dialog.addEventListener("focusin", () => { void resumeClipboard(); });
    dialog.querySelector("video").addEventListener("pointerdown", () => { void pushLocalClipboard(); });
    dialog.querySelector("[data-file-support]").textContent = typeof window.showSaveFilePicker === "function" ? "收到文件后请选择保存位置。浏览器确认覆盖已有文件时，请检查文件名。" : "此浏览器不支持流式保存文件，接收功能不可用；请使用支持文件保存选择器的浏览器或桌面客户端。";
    dialog.querySelector("[data-file-send]").addEventListener("click", safe(async () => { await enableFiles(); const input = dialog.querySelector("[data-file-input]"); await current.transfers.offerFiles([...input.files]); input.value = ""; }));
    function fileRow(id, name) {
      if (current.rows.has(id)) return current.rows.get(id);
      if (current.rows.size >= 128) { const oldest = current.rows.keys().next().value; current.rows.get(oldest).row.remove(); current.rows.delete(oldest); }
      const row = document.createElement("div"), text = document.createElement("span"), filename = document.createElement("span"), cancel = document.createElement("button"); row.className = "remote-file-row";
      filename.dataset.noTranslate = ""; filename.textContent = name ?? id;
      cancel.className = "button button-secondary"; cancel.textContent = "取消"; cancel.addEventListener("click", safe(async () => { const result = await current.transfers.cancel(id); text.textContent = result.mayBeSaved ? "已停止传输；保存可能已完成，请检查接收位置" : "已停止传输"; cancel.disabled = true; }));
      row.append(filename, text, cancel); dialog.querySelector("[data-file-list]").append(row);
      const entry = { row, text, cancel }; current.rows.set(id, entry); return entry;
    }
    function fileProgress(progress) {
      if (current.disposed) return;
      const row = fileRow(progress.id, progress.name);
      if (progress.complete || progress.error) { row.text.textContent = progress.complete ? "校验完成，文件已保存" : progress.mayBeSaved ? "已停止传输；保存可能已完成，请检查接收位置" : message(new Error(progress.error)); row.cancel.disabled = true; }
      else if (!progress.offered) row.text.textContent = `${progress.received ?? progress.sent ?? 0} / ${progress.size} 字节`;
    }
    function offerFile(offer) {
      showPanel("[data-file-panel]", true);
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
