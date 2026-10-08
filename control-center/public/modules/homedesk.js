// Native launch carries only a remote ID. Credentials and trust settings stay in HomeDesk.
export function homeDeskUrl(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  return `homedesk://${id}`;
}

export function createHomeDeskView({ api, state, viewContent, escapeHtml }) {
  let generation = 0;
  async function renderRemote(renderId = state.renderId) {
    const current = ++generation;
    const [config, bindings, first] = await Promise.all([
      api("/api/v1/homedesk/config"), api("/api/v1/homedesk/devices"),
      api("/api/v1/client/devices?page=1&page_size=100"),
    ]);
    const devices = [...first.items];
    for (let page = 2; page <= Math.min(first.total_pages ?? 1, 10); page++) {
      const next = await api(`/api/v1/client/devices?page=${page}&page_size=100`);
      devices.push(...next.items);
    }
    if (renderId !== state.renderId || current !== generation) return;
    const byDevice = new Map(bindings.items.map((binding) => [binding.device_id, binding]));
    const rows = devices.filter((device) => device.status === "active").map((device) => {
      const binding = byDevice.get(device.id);
      const matching = binding && binding.server === config.server && binding.key_sha256 === config.key_sha256;
      const href = matching ? homeDeskUrl(binding.remote_id) : null;
      return `<tr><td><strong data-no-translate>${escapeHtml(device.name)}</strong><div class="helper">${escapeHtml(binding?.platform ?? "")}</div></td>
        <td>${binding ? escapeHtml(binding.remote_id) : "尚未登记"}</td>
        <td>${binding?.online ? "最近已登记" : "未收到近期登记"}</td>
        <td>${href ? `<a class="button primary" href="${href}">用 HomeDesk 连接</a>
          <button class="button" data-homedesk-copy="${escapeHtml(binding.remote_id)}">复制 ID</button>` : "请在这台设备上安装 HomeDesk、配置远控并接入账号"}</td></tr>`;
    }).join("");
    viewContent.innerHTML = `<section class="panel homedesk-directory">
      <div class="section-header"><div><h2>家庭远控</h2><p>画面、声音、输入与文件只在两端设备之间传输。</p></div>
        <a class="button" href="https://github.com/ZHanry/home-tunnel-client/releases" target="_blank" rel="noopener noreferrer">下载 HomeDesk</a></div>
      <p class="helper">远控必须 P2P 直连。打洞失败会明确停止，不使用中继。设备登记状态不代表已经建立远控连接。</p>
      ${config.configured ? `<p class="helper">信令服务器：${escapeHtml(config.server)}。客户端需配置同一服务器与公钥。</p>` :
        `<p role="status">管理员尚未配置 hbbs 信令服务器与公钥。请先按部署说明完成配置。</p>`}
      <div class="table-wrap"><table><thead><tr><th>设备</th><th>远控 ID</th><th>登记状态</th><th>操作</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4">没有已接入的设备。请先在家庭电脑上安装 HomeDesk 并登录账号。</td></tr>'}</tbody></table></div>
      <p class="helper">首次连接会由系统打开 HomeDesk；未打开时可复制 ID，在客户端输入。隧道服务仍由“连接管理”独立管理。</p>
      <p data-homedesk-message role="status" aria-live="polite"></p>
    </section>`;
    for (const button of viewContent.querySelectorAll("[data-homedesk-copy]")) {
      button.onclick = async () => {
        const message = viewContent.querySelector("[data-homedesk-message]");
        try {
          await navigator.clipboard.writeText(button.dataset.homedeskCopy);
          if (message) message.textContent = "已复制远控 ID";
        } catch {
          if (message) message.textContent = "浏览器无法复制，请手动选中远控 ID。";
        }
      };
    }
  }
  return { renderRemote, closeRemote: () => { generation++; } };
}
