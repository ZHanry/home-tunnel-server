export function createConnectionsView({
  api,
  allPages,
  state,
  isAdmin,
  connectionsPath,
  devicesPath,
  annotateOwnedConnections,
  updateTransportTunnelState,
  viewContent,
  escapeHtml,
  emptyState,
  publicAddress,
  isRawProxy,
  statusBadge,
  connectionDiagnostic,
  accessBadges,
}) {
  async function renderConnections(renderId = state.renderId) {
    state.connectionQuery ??= { page: 1, search: "", userId: "" };
    const filter = state.connectionQuery;
    const params = new URLSearchParams({
      page: String(filter.page),
      page_size: "20",
      search: filter.search,
      user_id: filter.userId,
    });
    const [data, devicesPayload, usersPayload] = await Promise.all([
      api(connectionsPath() + `?${params}`),
      allPages(devicesPath()),
      isAdmin() ? api("/api/v1/admin/users") : Promise.resolve({ items: [] }),
    ]);
    if (renderId !== state.renderId) return;
    state.devices = devicesPayload.items;
    if (isAdmin()) state.users = usersPayload.items;
    state.connections = annotateOwnedConnections(data.items, state.devices);
    updateTransportTunnelState(data);
    const items = state.connections;
    const total = Number(data.total ?? items.length),
      pages = Number(data.total_pages ?? 1);
    viewContent.innerHTML = `<form class="connection-filter panel" id="connection-filter"><div class="field"><label for="connection-search">查找连接</label><input id="connection-search" type="search" name="search" value="${escapeHtml(filter.search)}" placeholder="输入名称、地址或用户"></div>${isAdmin() ? `<div class="field"><label for="connection-owner">所属用户</label><select name="user_id" id="connection-owner"><option value="">全部用户</option>${state.users.map((u) => `<option data-no-translate value="${u.id}" ${filter.userId === u.id ? "selected" : ""}>${escapeHtml(u.display_name)} · ${escapeHtml(u.username)}</option>`).join("")}</select></div>` : ""}<button class="button button-secondary" type="submit">搜索</button></form>
    <div class="section-intro"><p><strong>${total}</strong> 条连接</p><span>配置保存后自动同步到家庭设备</span></div>
    <div class="actions connection-batch"><button class="button button-secondary button-small" data-action="batch-connections" data-enabled="false">暂停所选连接</button><button class="button button-secondary button-small" data-action="batch-connections" data-enabled="true">恢复所选连接</button><span class="helper">每页独立选择，切页后清空</span></div>
    ${items.length ? `<section class="connection-table" role="table" aria-label="家庭连接"><div class="connection-table-header" role="row"><div role="columnheader" data-column="name"><span class="connection-name-label">服务与设备</span></div><div role="columnheader" data-column="address">访问地址</div><div role="columnheader" data-column="target">本地目标</div><div role="columnheader" data-column="state">状态</div><div role="columnheader" data-column="actions">操作</div></div><div class="connection-grid" role="rowgroup">${items.map(renderConnectionCard).join("")}</div></section>` : `<section class="panel">${filter.search || filter.userId ? emptyState("没有匹配的连接", "请调整关键词或用户筛选后重试。") : emptyState("创建第一条家庭连接", "先在家庭电脑上安装客户端，用同一账号登录，然后把本地服务发布到公网。", "create-connection", "创建连接")}<a class="button button-secondary setup-link" href="/" target="_blank" rel="noopener">安装客户端与快速开始</a></section>`}
    ${`<footer class="pagination panel"><span>第 ${filter.page} / ${pages} 页 · 共 ${total} 条</span><div><button class="button button-secondary" data-action="connection-page" data-page="${filter.page - 1}" ${filter.page <= 1 ? "disabled" : ""}>上一页</button><button class="button button-secondary" data-action="connection-page" data-page="${filter.page + 1}" ${filter.page >= pages ? "disabled" : ""}>下一页</button></div></footer>`}`;
  }

  function renderConnectionCard(connection) {
    const raw = isRawProxy(connection.proxy_type),
      address = publicAddress(connection);
    const actionClass = "button button-secondary button-small";
    return `<article class="connection-card connection-row panel" role="row"><div class="connection-row-main" role="cell" data-column="name"><label class="connection-select"><input type="checkbox" data-select-connection value="${connection.id}"><span class="visually-hidden">选择此连接</span></label><span class="connection-symbol" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7 .4l3-3a5 5 0 0 0-7-7l-2 2m3 6a5 5 0 0 0-7-.4l-3 3a5 5 0 0 0 7 7l2-2"/></svg></span><div class="connection-identity"><div class="connection-title"><h3 data-no-translate>${escapeHtml(connection.name)}</h3></div><p class="connection-meta" data-no-translate>${escapeHtml(connection.device_name)}${isAdmin() ? ` · ${escapeHtml(connection.username)}` : ""}</p><div class="connection-policy">${raw ? `<span class="status-badge neutral">${connection.proxy_type.toUpperCase()} · 应用自行保护</span>` : accessBadges(connection)}</div></div></div>
    <div class="connection-row-address" role="cell" data-column="address" data-label="访问地址"><div class="public-address">${!raw && connection.public_url ? `<a class="public-url" data-no-translate href="${escapeHtml(connection.public_url)}" target="_blank" rel="noopener">${escapeHtml(address)}</a>` : `<span class="public-url" data-no-translate title="${escapeHtml(address)}">${escapeHtml(address)}</span>`}<button class="button button-secondary button-small" type="button" data-copy="${escapeHtml(address)}" aria-label="复制公网地址">复制</button></div></div>
    <div class="connection-row-target" role="cell" data-column="target" data-label="本地目标"><p class="connection-target" data-no-translate>${escapeHtml(raw ? connection.proxy_type : connection.local_scheme)}://${escapeHtml(connection.local_host)}:${connection.local_port}</p><p class="connection-reason">${escapeHtml(connectionDiagnostic(connection))}</p></div>
    <div class="connection-row-state" role="cell" data-column="state">${statusBadge(connection.enabled ? connection.state : "paused")}</div>
    <footer class="connection-actions" role="cell" data-column="actions"><button class="${actionClass}" data-action="connection-details" data-id="${connection.id}">查看详情</button><button class="${actionClass}" data-action="edit-connection" data-id="${connection.id}">编辑</button><button class="${actionClass}" data-action="toggle-connection" data-id="${connection.id}">${connection.enabled ? "暂停" : "启用"}</button><details class="more-actions"><summary class="${actionClass}" aria-label="更多连接操作"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg><span>更多</span></summary><div role="group" aria-label="更多连接操作">${!raw ? `<button class="button button-quiet" data-action="custom-domains" data-id="${connection.id}">自定义域名</button>` : ""}<button class="button button-danger" data-action="delete-connection" data-id="${connection.id}">删除连接</button></div></details></footer></article>`;
  }

  return { renderConnections };
}
