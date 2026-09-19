export function createAccountSecurityView({api,state,viewContent,escapeHtml,formatDate,openModal,field,modal,showSecret,toast,renderAccount}) {
  const credentials = () => `${field("password","当前密码","",{type:"password"})}${field("mfa_code","动态码或恢复码","",{type:"password",required:false,helper:"已启用双重验证时必填；每个动态码只能使用一次"})}`;
  const bodyCredentials = form => ({password:form.get("password"),mfa_code:form.get("mfa_code") || undefined});
  const post = (path,body) => api(`/api/v1/${path}`,{method:"POST",body:JSON.stringify(body)});
  function setup() {
    openModal({title:"添加验证器",body:credentials(),onSubmit:async form=>{
      const result = await post("auth/mfa/setup",bodyCredentials(form));
      openModal({title:"确认双重验证",body:`<p>在验证器中手动添加以下密钥，类型选择基于时间（TOTP），再输入生成的 6 位动态码。密钥 10 分钟内有效。</p><p class="secret-value" data-no-translate>${escapeHtml(result.secret)}</p>${field("password","再次输入当前密码","",{type:"password"})}${field("code","验证器动态码","",{type:"password"})}`,onSubmit:async confirmation=>{
        const enabled = await post("auth/mfa/confirm",{password:confirmation.get("password"),code:confirmation.get("code")});
        await renderAccount(state.renderId);
        showSecret("保存恢复码",enabled.recovery_codes.join("\n"),"每个恢复码只能使用一次。离线保存在安全位置；其他管理会话已退出。已登记设备仍保持接入。");
      }});
    }});
  }
  function factorAction(action) {
    openModal({title:action==="disable"?"关闭双重验证":"重新生成恢复码",body:credentials(),danger:action==="disable",onSubmit:async form=>{
      const result = await post(`auth/mfa/${action}`,bodyCredentials(form));
      await renderAccount(state.renderId);
      if (result?.recovery_codes) showSecret("新恢复码",result.recovery_codes.join("\n"),"旧恢复码已失效，请离线安全保存新恢复码。");
      else { modal.close("saved"); toast("双重验证已关闭，其他管理会话已退出"); }
    }});
  }
  function enrollment() {
    openModal({title:"生成一次性接入码",body:`<p>在新电脑客户端输入服务器地址和接入码，即可登记到当前账号。有效期 10 分钟，只能使用一次。</p>${field("name","用途备注","新设备")}`,onSubmit:async form=>{
      const result = await post("client/enrollment-codes",{name:form.get("name")});
      await renderAccount(state.renderId);
      showSecret("设备接入码",result.code,`仅用于此服务器，有效期至 ${formatDate(result.expires_at)}。请只交给你要接入的设备。`);
    }});
  }
  async function renderSecurity(renderId) {
    const [mfa,sessions,codes] = await Promise.all([api("/api/v1/auth/mfa"),api("/api/v1/auth/sessions"),api("/api/v1/client/enrollment-codes")]);
    if (renderId!==state.renderId) return;
    const section = document.createElement("section");
    section.className="form-stack";
    section.innerHTML=`<section class="panel account-panel"><h3>账号安全</h3><p>双重验证：<strong>${mfa.enabled?"已开启":"未开启"}</strong>${mfa.enabled?` · 剩余恢复码 ${mfa.recovery_codes_remaining} 个`:""}</p><div class="actions">${mfa.enabled?'<button class="button button-secondary" data-security="recovery-codes">重新生成恢复码</button><button class="button button-danger" data-security="disable">关闭双重验证</button>':'<button class="button button-primary" data-security="setup">添加验证器</button>'}</div></section>
    <section class="panel account-panel"><div class="panel-header"><h3>设备接入码</h3><button class="button button-secondary" data-security="enrollment">生成接入码</button></div><p class="helper">接入码只用于登记新电脑，不会显示账号密码。</p>${codes.items.map(code=>`<div class="section-intro"><span>${escapeHtml(code.name)} · ${formatDate(code.expires_at)} · ${code.consumed_at?"已使用":code.revoked_at?"已撤销":"待接入"}</span>${!code.consumed_at&&!code.revoked_at?`<button class="button button-quiet" data-revoke-code="${escapeHtml(code.id)}">撤销</button>`:""}</div>`).join("")}</section>
    <section class="panel account-panel"><h3>管理会话</h3><p class="helper">这里管理 Web、手机和未登记的桌面登录。已登记电脑的长期接入权限请在设备管理中撤销。</p>${sessions.items.map(session=>`<div class="section-intro"><div><strong>${escapeHtml(session.client_type)} ${session.current?"（当前会话）":""}</strong><p class="helper" data-no-translate>${escapeHtml(session.user_agent || "—")}</p><small>登录 ${formatDate(session.created_at)} · 最近刷新 ${formatDate(session.updated_at)}</small></div><button class="button button-secondary" data-revoke-session="${escapeHtml(session.id)}">退出此会话</button></div>`).join("")}${sessions.has_more?'<p class="helper">显示最近 100 个会话。修改密码可退出所有会话。</p>':""}</section>`;
    viewContent.append(section);
    section.addEventListener("click",async event=>{
      const button=event.target.closest("button"); if (!button) return;
      try {
        if (button.dataset.security==="setup") setup();
        else if (["disable","recovery-codes"].includes(button.dataset.security)) factorAction(button.dataset.security);
        else if (button.dataset.security==="enrollment") enrollment();
        else if (button.dataset.revokeCode) {
          await api(`/api/v1/client/enrollment-codes/${button.dataset.revokeCode}`,{method:"DELETE"}); await renderAccount(state.renderId);
        } else if (button.dataset.revokeSession) {
          await api(`/api/v1/auth/sessions/${button.dataset.revokeSession}`,{method:"DELETE"});
          if (sessions.items.find(item=>item.id===button.dataset.revokeSession)?.current) window.dispatchEvent(new CustomEvent("session-expired"));
          else await renderAccount(state.renderId);
        }
      } catch(error) { toast(error.message,"error"); }
    });
  }
  return {renderSecurity};
}
