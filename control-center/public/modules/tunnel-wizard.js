import { serviceTemplates, tunnelVerification } from "./tunnel-model.js?v=13.0.0";
import { localizedText as t } from "./locale.js?v=13.0.0";

const activeWizards = new WeakMap();
export function disposeTunnelWizard(modal) { activeWizards.get(modal)?.(); }

export function openTunnelWizard({ admin, state, catalog, api, allPages, openModal, modal, form, body, footer, error,
  field, escapeHtml: esc, accessFormFields, collectAccessPatch, bindAccessModeToggle, bindSubdomainAvailability,
  publicAddress, finish, edit }) {
  const life = new AbortController();
  let step = 0, created = null, poll = null, disposed = false, saving = false;
  const path = admin ? "/api/v1/admin/connections" : "/api/v1/client/connections";
  const allowed = (type) => type === "http" || (admin ? catalog.transport_tunnels?.[type]?.enabled === true : catalog.capabilities?.[type]?.can_create === true);
  const labels = ["设备与模板", "本地目标", "访问方式", "验证与地址"];
  const options = (items, label) => items.map((item) => `<option data-no-translate value="${esc(item.id)}">${esc(label(item))}</option>`).join("");
  const prefix = (state.me?.username ?? "user").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  openModal({ title: "发布内网服务", draftId: "create-tunnel", eyebrow: "内网穿透", submitLabel: "下一步",
    body: `<ol class="tunnel-steps" aria-label="发布步骤">${labels.map((label, index) => `<li data-step-label="${index}"><span aria-hidden="true">${index + 1}</span>${label}</li>`).join("")}</ol>
      <section class="tunnel-step form-grid" data-step="0"><h3 class="full" tabindex="-1">设备与模板</h3>
        ${admin ? `<div class="field"><label for="modal-user_id">用户</label><select id="modal-user_id" name="user_id" required>${options(state.users.filter((item) => item.status === "active"), (item) => `${item.display_name} · ${item.username}`)}</select></div>` : ""}
        <div class="field"><label for="modal-device_id">设备</label><select id="modal-device_id" name="device_id" required>${options(state.devices, (item) => item.name)}</select></div>
        <div class="field full"><label for="modal-client-preset">服务模板</label><select id="modal-client-preset" name="preset">${serviceTemplates.map((item) => `<option value="${item.id}" ${allowed(item.proxy) ? "" : "disabled"}>${item.name}</option>`).join("")}</select><p class="helper">模板可继续修改。不可选表示服务端尚未开放或账号没有权限。</p></div>
        ${field("name", "连接名称")}<p class="helper full" data-device-state role="status"></p></section>
      <section class="tunnel-step form-grid" data-step="1" hidden><h3 class="full" tabindex="-1">本地目标</h3>
        <div class="field" id="modal-local-scheme-field"><label for="modal-local_scheme">本地协议</label><select id="modal-local_scheme" name="local_scheme"><option value="http">HTTP</option><option value="https">HTTPS</option></select></div>
        ${field("local_host", "本地地址", "127.0.0.1")}${field("local_port", "本地端口", "8080", { type: "number", min: 1, max: 65535 })}
        <p class="helper full">本地地址属于所选设备。浏览器和服务器不会代替设备探测这个地址。</p></section>
      <section class="tunnel-step form-grid" data-step="2" hidden><h3 class="full" tabindex="-1">访问方式</h3>
        ${field("subdomain", "公网子域", `${prefix}-app`, { helper: `.${state.tunnelDomain}` })}
        <p class="helper full" data-port-allocation hidden>公网端口由服务器从允许的端口池自动分配。目标应用应配置认证与加密。</p>
        <div id="modal-http-options" class="field full"><div class="form-grid">${admin ? field("bandwidth_mbps", "连接上限 (Mbps)", "", { type: "number", required: false, min: 0.1 }) : ""}${accessFormFields()}</div></div>
        <div class="field full"><label><input name="enabled" type="checkbox" checked> 创建后立即启用</label></div></section>
      <section class="tunnel-step" data-step="3" hidden><h3 tabindex="-1">验证与地址</h3><div data-tunnel-summary></div><div data-tunnel-result aria-live="polite"></div></section>`,
    onSubmit: async (values) => {
      if (created) return;
      const template = serviceTemplates.find((item) => item.id === values.get("preset"));
      if (!template || !allowed(template.proxy)) throw new Error(t("当前账号不能发布这种服务。"));
      const raw = template.proxy !== "http";
      const bandwidth = String(values.get("bandwidth_mbps") ?? "").trim();
      const input = {
        ...(admin ? { user_id: values.get("user_id") } : {}),
        device_id: values.get("device_id"), name: values.get("name"), proxy_type: template.proxy,
        ...(!raw || admin ? { subdomain: values.get("subdomain") } : {}),
        ...(template.application ? { application_protocol: template.application } : {}),
        local_host: values.get("local_host"), local_port: Number(values.get("local_port")),
        local_scheme: raw ? "http" : values.get("local_scheme"), enabled: values.get("enabled") === "on",
        ...(!raw ? { access: collectAccessPatch(values), ...(admin ? { bandwidth_limit_bps: bandwidth ? Math.round(Number(bandwidth) * 1_000_000) : null } : {}) } : {}),
      };
      saving = true; previous.disabled = true;
      try {
        created = await api(path, { method: "POST", body: JSON.stringify(input), signal: life.signal });
        if (disposed) return;
        // Clear credentials immediately. Only configuration and its actual status remain on this step.
        body.querySelectorAll('input[type="password"]').forEach((node) => { node.value = ""; });
        body.querySelector("[data-tunnel-summary]").hidden = true;
        previous.hidden = true; submit.hidden = true;
        const done = document.createElement("button"); done.type = "button"; done.className = "button button-primary";
        done.textContent = t("查看连接"); done.addEventListener("click", () => finish(created), { signal: life.signal }); footer.append(done);
        renderResult(created);
        void verify();
      } finally { saving = false; previous.disabled = false; }
    },
  });
  activeWizards.set(modal, () => { disposed = true; poll?.abort(); life.abort(); activeWizards.delete(modal); });
  modal.addEventListener("close", () => disposeTunnelWizard(modal), { signal: life.signal, once: true });
  const submit = footer.querySelector('button[type="submit"]');
  const previous = document.createElement("button"); previous.type = "button"; previous.className = "button button-secondary";
  previous.textContent = t("上一步"); submit.before(previous);
  previous.addEventListener("click", () => { if (!saving) showStep(step - 1); }, { signal: life.signal });
  const sections = [...body.querySelectorAll("[data-step]")];
  form.addEventListener("home-tunnel:invalid-field", (event) => {
    const section = event.target.closest("[data-step]");
    if (section) showStep(Number(section.dataset.step), false);
  }, { signal: life.signal });
  form.addEventListener("home-tunnel:form-settled", () => {
    if (!created) submit.textContent = t(step === 3 ? "创建并验证" : "下一步");
  }, { signal: life.signal });
  const preset = form.elements.namedItem("preset"), owner = form.elements.namedItem("user_id"), device = form.elements.namedItem("device_id");
  const selectedDevice = () => state.devices.find((item) => item.id === device.value);
  function devices() {
    const available = state.devices.filter((item) => !admin || item.user_id === owner.value);
    const selected = device.value;
    device.innerHTML = options(available, (item) => item.name);
    device.value = available.some((item) => item.id === selected) ? selected : (available[0]?.id ?? "");
    device.disabled = available.length === 0; submit.disabled = available.length === 0;
    body.querySelector("[data-device-state]").textContent = t(!available.length ? "这个用户还没有设备。请先安装客户端并用该账号登录。" : selectedDevice()?.online ? "所选设备在线。" : "设备离线，保存后会等待设备上线。" );
    if (!created && step === 3) summary();
  }
  function applyTemplate(defaults) {
    const template = serviceTemplates.find((item) => item.id === preset.value);
    const raw = template?.proxy !== "http";
    if (defaults && template) { form.elements.namedItem("local_port").value = template.port; form.elements.namedItem("local_scheme").value = template.scheme ?? "http"; }
    const scheme = form.elements.namedItem("local_scheme"), subdomain = form.elements.namedItem("subdomain");
    scheme.disabled = raw; scheme.closest(".field").hidden = raw;
    subdomain.disabled = raw && !admin; subdomain.required = !raw || admin; subdomain.closest(".field").hidden = raw && !admin;
    body.querySelector('label[for="modal-subdomain"]').textContent = t(raw ? "连接标识" : "公网子域");
    body.querySelector("[data-port-allocation]").hidden = !raw;
    const protection = body.querySelector("#modal-http-options"); protection.hidden = raw;
    protection.querySelectorAll("input,select,textarea").forEach((node) => { node.disabled = raw; node.required = false; });
    if (!raw) form.elements.namedItem("access_basic_mode").dispatchEvent(new Event("change"));
  }
  function summary() {
    const template = serviceTemplates.find((item) => item.id === preset.value);
    const target = `${form.elements.namedItem("local_host").value}:${form.elements.namedItem("local_port").value}`;
    body.querySelector("[data-tunnel-summary]").innerHTML = `<dl class="connection-detail"><dt>设备</dt><dd data-no-translate>${esc(selectedDevice()?.name ?? "")}</dd><dt>服务模板</dt><dd data-no-translate>${esc(template?.name ?? "")}</dd><dt>本地目标</dt><dd data-no-translate>${esc(target)}</dd><dt>访问方式</dt><dd>${template?.proxy === "http" ? `<span data-no-translate>https://${esc(form.elements.namedItem("subdomain").value)}.${esc(state.tunnelDomain)}</span>` : "公网端口在创建时由服务器分配"}</dd></dl><p class="helper">创建后会读取设备上报的应用进度和目标诊断，保存成功不代表服务可用。</p>`;
  }
  function showStep(value, focus = true) {
    step = Math.max(0, Math.min(3, value));
    sections.forEach((node, index) => { node.hidden = index !== step; });
    body.querySelectorAll("[data-step-label]").forEach((node, index) => { if (index === step) node.setAttribute("aria-current", "step"); else node.removeAttribute("aria-current"); });
    previous.hidden = step === 0;
    submit.textContent = t(step === 3 ? "创建并验证" : "下一步");
    if (step === 3) summary();
    if (focus) sections[step].querySelector("h3").focus();
  }
  function invalidIn(section) { return [...section.querySelectorAll("input,select,textarea")].find((node) => !node.disabled && !node.checkValidity()); }
  form.addEventListener("submit", (event) => {
    if (saving || created) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    const invalid = invalidIn(step === 3 ? body : sections[step]);
    if (invalid || step < 3) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (invalid) { showStep(Number(invalid.closest("[data-step]").dataset.step), false); invalid.closest("details")?.setAttribute("open", ""); invalid.reportValidity(); }
      else showStep(step + 1);
    }
  }, { capture: true, signal: life.signal });
  function renderResult(connection, message = null) {
    const result = tunnelVerification(connection, selectedDevice());
    const address = publicAddress(connection);
    const panel = body.querySelector("[data-tunnel-result]");
    const renderKey = JSON.stringify([result, address, message]);
    if (panel.dataset.renderKey === renderKey) return result.state;
    panel.dataset.renderKey = renderKey;
    panel.dataset.verification = result.state;
    panel.innerHTML = `<p class="tunnel-result-status">${esc(t(message ?? result.message))}</p><p class="helper">公网地址已分配，实际可用性以验证结果为准。</p><div class="public-address"><span data-no-translate>${esc(address)}</span><button type="button" class="button button-secondary" data-copy="${esc(address)}">复制</button></div><p class="helper">目标检查来自所选设备；公网 DNS、TLS 和访问保护请从外部网络验证。</p><div class="actions"><button type="button" class="button button-secondary" data-verify>刷新验证</button><button type="button" class="button button-quiet" data-fix>修改配置</button></div>`;
    panel.querySelector("[data-verify]").addEventListener("click", () => void verify(), { signal: life.signal });
    panel.querySelector("[data-fix]").addEventListener("click", () => edit(connection), { signal: life.signal });
    return result.state;
  }
  async function verify() {
    error.textContent = "";
    poll?.abort(); const current = new AbortController(); poll = current;
    const signal = AbortSignal.any([life.signal, current.signal, AbortSignal.timeout(30_000)]);
    const deadline = Date.now() + 30_000;
    try {
      while (!signal.aborted) {
        const [connection, refreshedDevices] = await Promise.all([
          api(`${path}/${encodeURIComponent(created.id)}`, { signal }),
          allPages(`${admin ? "/api/v1/admin" : "/api/v1/client"}/devices`, { signal }),
        ]);
        if (signal.aborted || disposed) return;
        const stored = selectedDevice(), refreshedDevice = refreshedDevices.items.find((item) => item.id === created.device_id);
        if (stored && refreshedDevice) Object.assign(stored, refreshedDevice);
        else if (stored) stored.online = false;
        created = connection;
        const status = renderResult(connection);
        if (status !== "pending") return;
        if (Date.now() >= deadline) { renderResult(connection, "仍在等待设备验证。可以稍后刷新，或在连接详情继续排查。"); return; }
        await new Promise((resolve) => { const timer = setTimeout(resolve, 2000); signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); });
      }
      if (!current.signal.aborted && !disposed) renderResult(created, "仍在等待设备验证。可以稍后刷新，或在连接详情继续排查。");
    } catch (failure) {
      if (!current.signal.aborted && !disposed) {
        renderResult(created, signal.aborted ? "仍在等待设备验证。可以稍后刷新，或在连接详情继续排查。" : "连接已保存，但暂时无法读取验证结果。请检查网络后刷新。");
        if (!signal.aborted) error.textContent = failure.message;
      }
    }
  }
  bindAccessModeToggle(); bindSubdomainAvailability();
  if (admin && modal.dataset.restored !== "true") owner.value = state.devices[0]?.user_id ?? owner.value;
  owner?.addEventListener("change", devices, { signal: life.signal });
  device.addEventListener("change", devices, { signal: life.signal });
  preset.addEventListener("change", () => applyTemplate(true), { signal: life.signal });
  devices(); applyTemplate(false); showStep(0, false);
}
