import { pagination } from "./pagination.js?v=14.0.0";
import { t } from "./locale.js?v=14.0.0";
import { physicalDevices, filterPhysicalDevices, deviceGroup } from "./physical-devices.js?v=14.0.0";

export function createDevicesView({api,allPages,state,viewContent,pageActions,escapeHtml,formatDate,emptyState,isAdmin,navigateTo,openModal}) {
  let generation=0;
  async function extension(path) {
    try {return await api(path);} catch(error) {
      if(error.status===404)return {version:1,items:[]};
      throw error;
    }
  }
  async function renderDevices(renderId=state.renderId) {
    const current=++generation, accountId=state.me?.id;
    const administrative=state.currentView==='admin-devices';
    if(administrative&&!isAdmin())return;
    const key=administrative?'adminDeviceQuery':'deviceQuery';
    state[key]??={page:1,search:'',status:'all'};
    const [subjects,links,bindings,config]=await Promise.all([
      allPages(administrative?'/api/v1/admin/devices':'/api/v1/client/devices'),
      extension(administrative?'/api/v2/admin/device-capabilities':'/api/v2/auth/device-capabilities'),
      api('/api/v2/homedesk/devices'),api('/api/v2/homedesk/config')]);
    if(renderId!==state.renderId||current!==generation||accountId!==state.me?.id)return;
    state.devices=subjects.items;
    state.physicalDevices=physicalDevices(subjects.items,links.items,bindings.items,administrative?null:accountId);
    const filtered=filterPhysicalDevices(state.physicalDevices,state[key]);
    const pageSize=24,pages=Math.max(1,Math.ceil(filtered.length/pageSize));
    state[key].page=Math.min(pages,Math.max(1,state[key].page));
    const rows=filtered.slice((state[key].page-1)*pageSize,state[key].page*pageSize);
    pageActions.innerHTML=`<form id="device-search-form" class="directory-tools"><input name="search" type="search" maxlength="120" aria-label="${t('查找设备','Find devices')}" value="${escapeHtml(state[key].search)}" placeholder="${t('名称或设备 ID','Name or device ID')}"><select name="status" aria-label="${t('设备状态','Device status')}">${[['all',t('全部状态','All states')],['online',t('在线','Online')],['offline',t('离线','Offline')]].map(([value,label])=>`<option value="${value}" ${state[key].status===value?'selected':''}>${label}</option>`).join('')}</select><button class="button button-secondary" type="submit">${t('搜索','Search')}</button>${administrative?'':`<button class="button button-secondary" type="button" data-action="manual-remote">${t('手动连接','Connect by ID')}</button>`}<button class="button button-secondary" type="button" data-action="refresh-view">${t('刷新','Refresh')}</button></form>`;
    const row=device=>{
      const ready=!administrative&&device.remote_ready&&device.binding.server===config.server&&device.binding.key_sha256===config.key_sha256;
      const capability=(subject,online)=>!subject?t('未提供','Unavailable'):online?t('在线','Online'):t('离线','Offline');
      return `<article class="device-directory-row" data-physical-device="${escapeHtml(device.id)}"><span class="directory-device-icon" aria-hidden="true"><svg viewBox="0 0 24 24">${deviceGroup(device)==='mobile'?'<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M10 18h4"/>':'<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>'}</svg></span><div class="directory-device-identity"><h3 data-no-translate>${escapeHtml(device.name)}</h3><p data-no-translate>${escapeHtml(device.binding?.remote_id??device.id)}</p><small data-no-translate>${escapeHtml(device.platform)}${administrative?` · ${escapeHtml(device.username??device.user_id)}`:''}</small></div><div class="device-capability-states"><span>${t('远程协助','Remote assistance')} <b class="${device.remote_ready?'capability-online':''}">${capability(device.remote,device.remote_ready)}</b></span><span>${t('内网穿透','Tunnels')} <b class="${device.tunnel_ready?'capability-online':''}">${capability(device.tunnel,device.tunnel_ready)}</b></span></div><div class="device-row-actions">${ready?`<button class="button button-primary button-small" data-action="directory-connect" data-id="${escapeHtml(device.id)}">${t('连接','Connect')}</button>`:''}<button class="button button-secondary button-small" data-action="device-info" data-id="${escapeHtml(device.id)}">${t('设备信息','Device details')}</button></div></article>`;
    };
    viewContent.innerHTML=rows.length?`<div class="device-directory">${[['computer',t('电脑','Computers')],['mobile',t('手机与平板','Phones and tablets')]].map(([group,title])=>{
      const members=rows.filter(device=>deviceGroup(device)===group);
      return members.length?`<details class="device-directory-group" open data-device-group="${group}"><summary>${title}</summary><div>${members.map(row).join('')}</div></details>`:'';
    }).join('')}</div>${pagination({page:state[key].page,pages,total:filtered.length,pageSize,action:'device-page',label:t('设备分页','Device pages')})}`:`<section class="panel directory-empty">${emptyState(t('没有匹配设备','No matching devices'),t('安装客户端并登录，或调整搜索条件。','Install the app and sign in, or change the filters.'))}</section>`;
    pageActions.querySelector('#device-search-form').addEventListener('submit',event=>{
      event.preventDefault();const data=new FormData(event.currentTarget);
      state[key]={page:1,search:String(data.get('search')).trim(),status:data.get('status')};
      void navigateTo(state.currentView,true);
    });
  }
  function showDeviceInfo(id) {
    const device=state.physicalDevices?.find(item=>item.id===id);if(!device)return;
    const administrative=state.currentView==='admin-devices';
    openModal({title:`${t('设备信息','Device details')} · ${device.name}`,draftId:`device-info:${id}`,submitLabel:t('关闭','Close'),
      body:`<dl class="device-info"><dt>${t('设备 ID','Device ID')}</dt><dd data-no-translate>${escapeHtml(device.binding?.remote_id??device.id)}</dd><dt>${t('平台','Platform')}</dt><dd data-no-translate>${escapeHtml(device.platform||'—')}</dd><dt>${t('客户端版本','Client version')}</dt><dd data-no-translate>${escapeHtml(device.client_version??'—')}</dd><dt>${t('最后在线','Last seen')}</dt><dd>${formatDate(device.last_seen_at)}</dd><dt>${t('标签','Tags')}</dt><dd data-no-translate>${device.tags.map(escapeHtml).join(', ')||'—'}</dd></dl><div class="actions"><button class="button button-secondary" type="button" data-action="device-metadata" data-id="${escapeHtml(device.metadata_subject.id)}">${t('编辑标签','Edit tags')}</button>${device.tunnel?`<button class="button button-secondary" type="button" data-action="device-services" data-id="${escapeHtml(device.tunnel.id)}">${t('穿透服务','Tunnel services')}</button>`:''}<button class="button button-danger" type="button" data-action="${administrative?'purge-physical-device':'remove-physical-device'}" data-id="${escapeHtml(device.id)}">${administrative?t('永久删除设备','Permanently delete device'):t('移除设备','Remove device')}</button></div>`,onSubmit:()=>document.querySelector('#modal').close('done')});
  }
  return {renderDevices,showDeviceInfo};
}
