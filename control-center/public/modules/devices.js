export function createDevicesView({api,state,devicesPath,viewContent,escapeHtml,statusBadge,configState,formatDate,emptyState,isAdmin}) {
  async function renderDevices(renderId=state.renderId) {
    state.deviceQuery ??= {page:1,search:""};
    const {page,search}=state.deviceQuery;
    const data=await api(`${devicesPath()}?${new URLSearchParams({page:String(page),page_size:"24",search})}`);
    if(renderId!==state.renderId)return;
    state.devices=data.items;
    viewContent.innerHTML=`<form class="connection-filter panel" id="device-search-form"><div class="field"><label for="device-search">查找设备</label><input id="device-search" name="search" type="search" maxlength="120" value="${escapeHtml(search)}" placeholder="设备名称或标签"></div><button class="button button-secondary">搜索</button></form>
      <div class="section-intro"><p>共 ${Number(data.total ?? data.items.length)} 台设备</p><span>标签与收藏不会重启隧道</span></div>
      <section class="device-grid">${data.items.length?data.items.map(device=>`<article class="panel device-tile"><div class="device-heading">${statusBadge(device.status==="active"&&device.online?"active":device.status==="active"?"Offline":device.status)}</div><h3 data-no-translate>${device.favorite?"★ ":""}${escapeHtml(device.name)}</h3><p class="cell-secondary" data-no-translate>${escapeHtml(device.username??state.me.username)}</p><p data-no-translate>${(device.tags??[]).map(escapeHtml).join(" · ")}</p><dl><dt>配置同步</dt><dd>${configState(device)}</dd><dt>最后在线</dt><dd>${formatDate(device.last_seen_at)}</dd><dt>客户端版本</dt><dd>${escapeHtml(device.client_version??"—")}</dd></dl><footer><button class="button button-secondary button-small" data-action="device-metadata" data-id="${device.id}">标签与收藏</button>${isAdmin()?`<button class="button button-danger button-small" data-action="delete-device" data-id="${device.id}" data-name="${escapeHtml(device.name)}">删除设备</button>`:""}</footer></article>`).join(""):emptyState("没有匹配设备","安装客户端并登录，或调整搜索条件。")}</section>
      <footer class="pagination panel"><span>第 ${page} / ${Number(data.total_pages??1)} 页</span><div><button class="button button-secondary" data-action="device-page" data-page="${page-1}" ${page<=1?"disabled":""}>上一页</button><button class="button button-secondary" data-action="device-page" data-page="${page+1}" ${page>=Number(data.total_pages??1)?"disabled":""}>下一页</button></div></footer>`;
    viewContent.querySelector("#device-search-form").addEventListener("submit",event=>{
      event.preventDefault();state.deviceQuery={page:1,search:new FormData(event.currentTarget).get("search").trim()};
      renderDevices().catch(error=>{viewContent.textContent=error.message;});
    });
  }
  return {renderDevices};
}
