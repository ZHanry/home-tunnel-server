import { t } from "./locale.js?v=12.0.0-RC1";
import { pagination } from "./pagination.js?v=12.0.0-RC1";

// Only a device ID is passed to the app. Every native entry point checks login.
export function homeDeskUrl(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  return `homedesk://${id}`;
}

export function createNestLinkView({ api, state, viewContent, escapeHtml }) {
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
      return `<article class="remote-device"><div class="remote-device-top"><span class="device-symbol" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></svg></span><span class="status-badge ${ready ? "ok" : "neutral"}">${ready ? t("在线", "Online") : t("离线", "Offline")}</span></div><h3 data-no-translate>${escapeHtml(device.name)}</h3><p class="cell-secondary" data-no-translate>${escapeHtml(binding?.platform ?? device.client_type ?? "")}</p><footer><span data-no-translate>${binding ? escapeHtml(binding.remote_id) : ""}</span>${href ? `<a class="button button-secondary button-small" href="${href}">${t("连接设备", "Connect")}</a>` : `<span class="cell-secondary">${t("未就绪", "Not ready")}</span>`}</footer></article>`;
    }).join("");
    const recent = readRecent();
    viewContent.innerHTML = `<div class="remote-workbench">
      <section class="panel remote-connect"><h2>${t("发起连接", "Connect to a device")}</h2><form id="remote-connect-form" class="form-stack"><div class="field"><label for="remote-target-id">${t("设备 ID", "Device ID")}</label><input id="remote-target-id" name="remote_id" required maxlength="64" pattern="[A-Za-z0-9_-]{1,64}" autocomplete="off" placeholder="${t("输入对方的设备 ID", "Enter the other device ID")}"></div><button class="button button-primary" type="submit">${t("打开客户端连接", "Connect in the app")}</button><p id="remote-launch-status" class="helper" role="status" aria-live="polite"></p></form></section>
      <section class="panel remote-recent"><h2>${t("最近连接", "Recent connections")}</h2>${recent.length ? recent.map(id => `<a class="recent-device-row" href="${homeDeskUrl(id)}"><span data-no-translate>${escapeHtml(id)}</span><span>${t("连接设备", "Connect")}</span></a>`).join("") : `<div class="empty-state"><strong>${t("还没有连接记录", "No recent connections")}</strong></div>`}</section>
      <section class="panel remote-family"><div class="panel-header"><h2>${t("我的设备", "My devices")}</h2><form id="remote-search-form" class="remote-search"><input type="search" name="search" maxlength="120" aria-label="${t("查找设备", "Find devices")}" value="${escapeHtml(search)}" placeholder="${t("查找设备", "Find devices")}"><button class="button button-secondary button-small">${t("搜索", "Search")}</button></form></div>
      ${config.configured ? "" : `<p role="status">${t("远控服务尚未配置，请联系管理员。", "Remote service is not configured. Contact your administrator.")}</p>`}
      ${tiles ? `<div class="remote-device-grid">${tiles}</div>` : `<div class="empty-state remote-empty"><span class="device-symbol" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></svg></span><strong>${t("还没有设备", "No devices yet")}</strong><p>${t("在设备上安装栖云桥并登录账号。", "Install NestLink on a device and sign in.")}</p><a class="button button-secondary" href="https://github.com/ZHanry/home-tunnel-client/releases" target="_blank" rel="noopener noreferrer">${t("下载客户端", "Download the app")}</a></div>`}</section></div>
      ${pagination({ page, pages: devices.total_pages, total: devices.total, pageSize: 6, action: "remote-page", label: t("远控设备分页", "Remote device pages") })}`;
    viewContent.querySelector("#remote-connect-form").addEventListener("submit", event => {
      event.preventDefault();
      const form = event.currentTarget;
      if (!form.reportValidity()) return;
      const id = form.elements.remote_id.value.trim();
      const href = homeDeskUrl(id);
      if (!href) return;
      saveRecent(id);
      viewContent.querySelector("#remote-launch-status").textContent = t("已请求打开栖云桥；请在客户端登录并完成连接。", "Opening NestLink. Sign in to the app to finish connecting.");
      location.assign(href);
    });
    viewContent.querySelector("#remote-search-form").addEventListener("submit", event => {
      event.preventDefault();
      state.remoteQuery = { page: 1, search: new FormData(event.currentTarget).get("search").trim() };
      void renderRemote().catch(error => { viewContent.textContent = error.message; });
    });
    for (const link of viewContent.querySelectorAll('a[href^="homedesk://"]')) {
      link.addEventListener("click", () => saveRecent(link.getAttribute("href").slice("homedesk://".length)));
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
  return { renderRemote, closeRemote: () => { generation++; } };
}
export { createNestLinkView as createHomeDeskView };
