import { t } from "./locale.js?v=14.0.0";
import { createBrowserRemote } from "./browser-remote.js?v=14.0.0";

export function homeDeskUrl(id) {
  return typeof id==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(id)?`homedesk://${id}`:null;
}
export function createNestLinkView({api,state,viewContent,escapeHtml}) {
  const browser=createBrowserRemote({api,escapeHtml});let generation=0;
  async function renderRemote(renderId=state.renderId) {
    const current=++generation,account=state.me?.id;
    const config=await api('/api/v2/homedesk/config');
    if(renderId!==state.renderId||current!==generation||account!==state.me?.id)return;
    const recent=readRecent();
    viewContent.innerHTML=`<div class="remote-workbench"><section class="panel remote-connect"><h2>${t('远控伙伴设备','Connect to a partner device')}</h2><p class="helper">${t('输入对方的设备 ID，发起远程连接。','Enter their device ID to start a remote connection.')}</p><form id="remote-connect-form" class="form-stack"><div class="field"><label for="remote-target-id">${t('设备 ID','Device ID')}</label><input id="remote-target-id" name="remote_id" required maxlength="64" pattern="[A-Za-z0-9_-]{1,64}" autocomplete="off" placeholder="${t('输入对方的设备 ID','Enter the other device ID')}"></div><div class="field"><label for="remote-password">${t('远控密码','Remote password')}</label><input id="remote-password" name="password" type="password" maxlength="128" autocomplete="off" placeholder="${t('可留空，由对方批准连接','Optional; the host can approve instead')}"></div><button class="button button-primary" type="submit">${t('连接','Connect')}</button><p id="remote-launch-status" class="helper" role="status" aria-live="polite"></p></form>${config.configured?'':`<p role="status">${t('远控服务尚未配置，请联系管理员。','Remote service is not configured. Contact your administrator.')}</p>`}</section><section class="panel remote-recent"><h2>${t('最近连接','Recent connections')}</h2>${recent.length?`<div class="remote-recent-list">${recent.map(id=>`<button class="recent-device-row" data-browser-connect="${escapeHtml(id)}"><span data-no-translate>${escapeHtml(id)}</span><span>${t('连接','Connect')}</span></button>`).join('')}</div>`:`<div class="empty-state remote-empty"><strong>${t('还没有连接记录','No recent connections')}</strong></div>`}</section></div>`;
    viewContent.querySelector('#remote-connect-form').addEventListener('submit',event=>{
      event.preventDefault();const form=event.currentTarget;
      if(!form.reportValidity())return;
      const id=form.elements.remote_id.value.trim();if(!homeDeskUrl(id))return;
      saveRecent(id);viewContent.querySelector('#remote-launch-status').textContent=t('正在请求远控连接。','Requesting remote control.');
      const password=form.elements.password.value;form.elements.password.value='';void browser.connect(id,password);
    });
    for(const button of viewContent.querySelectorAll('[data-browser-connect]'))button.addEventListener('click',()=>{
      const id=button.dataset.browserConnect;saveRecent(id);browser.request(id);
    });
  }
  function key(){return `nestlink.recent.${state.me?.id??''}`;}
  function readRecent(){try{const value=JSON.parse(localStorage.getItem(key())??'[]');return Array.isArray(value)?value.filter(id=>homeDeskUrl(id)).slice(0,6):[];}catch{return [];}}
  function saveRecent(id){try{localStorage.setItem(key(),JSON.stringify([id,...readRecent().filter(value=>value!==id)].slice(0,6)));}catch{}}
  return {renderRemote,closeRemote:()=>{generation++;browser.closeAll();}};
}
export { createNestLinkView as createHomeDeskView };
