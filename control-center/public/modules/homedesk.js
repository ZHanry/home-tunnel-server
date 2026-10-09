import { t } from "./locale.js?v=13.0.0";
import { pagination } from "./pagination.js?v=13.0.0";
import { createBrowserRemote } from "./browser-remote.js?v=13.0.0";

// Only a device ID is passed to the app. Every native entry point checks login.
export function homeDeskUrl(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  return `homedesk://${id}`;
}

export function createNestLinkView({ api, state, viewContent, escapeHtml }) {
  const browser = createBrowserRemote({ api, escapeHtml });
  let generation = 0;
  async function renderRemote(renderId = state.renderId) {
    const current = ++generation;
    state.remoteQuery ??= { page: 1, search: "" };
    const { page, search } = state.remoteQuery;
    const [config, bindings, devices] = await Promise.all([
      api("/api/v2/homedesk/config"), api("/api/v2/homedesk/devices"),
      api(`/api/v1/client/devices?${new URLSearchParams({ page: String(page), page_size: "6", search })}`),
    ]);
    if (renderId !== state.renderId || current !== generation) return;
    const byDevice = new Map(bindings.items.map(binding => [binding.device_id, binding]));
    const tiles = devices.items.filter(device => device.status === "active").map(device => {
      const binding = byDevice.get(device.id);
      const ready = binding?.online && binding.server === config.server && binding.key_sha256 === config.key_sha256;
      const href = ready ? homeDeskUrl(binding.remote_id) : null;
      return `<article class="remote-device"><div class="remote-device-top"><span class="device-symbol" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></svg></span><span class="status-badge ${ready ? "ok" : "neutral"}">${ready ? t("在线", "Online") : t("离线", "Offline")}</span></div><h3 data-no-translate>${escapeHtml(device.name)}</h3><p class="cell-secondary" data-no-translate>${escapeHtml(binding?.platform ?? device.client_type ?? "")}</p><footer><span data-no-translate>${binding ? escapeHtml(binding.remote_id) : ""}</span>${href ? `<button class="button button-secondary button-small" data-browser-connect="${escapeHtml(binding.remote_id)}">${t("连接设备", "Connect")}</button>` : `<span class="cell-secondary">${t("未就绪", "Not ready")}</span>`}</footer></article>`;
    }).join("");
    const recent = readRecent();
    viewContent.innerHTML = `<div class="remote-workbench">
      <section class="panel remote-connect"><h2>${t("发起连接", "Connect to a device")}</h2><form id="remote-connect-form" class="form-stack"><div class="field"><label for="remote-target-id">${t("设备 ID", "Device ID")}</label><input id="remote-target-id" name="remote_id" required maxlength="64" pattern="[A-Za-z0-9_-]{1,64}" autocomplete="off" placeholder="${t("输入对方的设备 ID", "Enter the other device ID")}"></div><div class="field"><label for="remote-password">${t("远控密码", "Remote password")}</label><input id="remote-password" name="password" type="password" maxlength="128" autocomplete="off" placeholder="${t("可留空，由对方批准连接", "Optional; the host can approve instead")}"></div><button class="button button-primary" type="submit">${t("连接设备", "Connect")}</button><p id="remote-launch-status" class="helper" role="status" aria-live="polite"></p></form></section>
      <section class="panel remote-recent"><h2>${t("最近连接", "Recent connections")}</h2>${recent.length ? recent.map(id => `<button class="recent-device-row" data-browser-connect="${escapeHtml(id)}"><span data-no-translate>${escapeHtml(id)}</span><span>${t("连接设备", "Connect")}</span></button>`).join("") : `<div class="empty-state"><strong>${t("还没有连接记录", "No recent connections")}</strong></div>`}</section>
      <section class="panel remote-family"><div class="panel-header"><h2>${t("我的设备", "My devices")}</h2><form id="remote-search-form" class="remote-search"><input type="search" name="search" maxlength="120" aria-label="${t("查找设备", "Find devices")}" value="${escapeHtml(search)}" placeholder="${t("查找设备", "Find devices")}"><button class="button button-secondary button-small">${t("搜索", "Search")}</button></form></div>
      ${config.configured ? "" : `<p role="status">${t("远控服务尚未配置，请联系管理员。", "Remote service is not configured. Contact your administrator.")}</p>`}
      ${tiles ? `<div class="remote-device-grid">${tiles}</div>` : `<div class="empty-state remote-empty"><span class="device-symbol" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></svg></span><strong>${t("还没有设备", "No devices yet")}</strong><p>${t("在设备上安装 nestlink 并登录账号。", "Install nestlink on a device and sign in.")}</p><a class="button button-secondary" href="https://github.com/ZHanry/home-tunnel-client/releases" target="_blank" rel="noopener noreferrer">${t("下载客户端", "Download the app")}</a></div>`}</section></div>
      ${pagination({ page, pages: devices.total_pages, total: devices.total, pageSize: 6, action: "remote-page", label: t("远控设备分页", "Remote device pages") })}`;
    viewContent.querySelector("#remote-connect-form").addEventListener("submit", event => {
      event.preventDefault();
      const form = event.currentTarget;
      if (!form.reportValidity()) return;
      const id = form.elements.remote_id.value.trim();
      const href = homeDeskUrl(id);
      if (!href) return;
      saveRecent(id);
      viewContent.querySelector("#remote-launch-status").textContent = t("正在请求远控连接。", "Requesting remote control.");
      const password = form.elements.password.value;
      form.elements.password.value = "";
      void browser.connect(id, password);
    });
    viewContent.querySelector("#remote-search-form").addEventListener("submit", event => {
      event.preventDefault();
      state.remoteQuery = { page: 1, search: new FormData(event.currentTarget).get("search").trim() };
      void renderRemote().catch(error => { viewContent.textContent = error.message; });
    });
    for (const button of viewContent.querySelectorAll('[data-browser-connect]')) {
      button.addEventListener("click", () => {
        const id = button.dataset.browserConnect; saveRecent(id); browser.request(id);
      });
    }
  }
  function recentKey() { return `nestlink.recent.${state.me?.id ?? ""}`; }
  function readRecent() {
    try { const value = JSON.parse(localStorage.getItem(recentKey()) ?? "[]"); return Array.isArray(value) ? value.filter(id => homeDeskUrl(id)).slice(0, 6) : []; }
    catch { return []; }
  }
  function saveRecent(id) {
    try { localStorage.setItem(recentKey(), JSON.stringify([id, ...readRecent().filter(value => value !== id)].slice(0, 6))); } catch {}
  }
  return { renderRemote, closeRemote: () => { generation++; browser.closeAll(); } };
}
export { createNestLinkView as createHomeDeskView };
