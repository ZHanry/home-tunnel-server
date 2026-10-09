export function createAccountSecurityView({ api, state, viewContent, escapeHtml, formatDate, toast, renderAccount }) {
  async function renderSecurity(renderId) {
    const sessions = await api("/api/v2/auth/sessions");
    if (renderId !== state.renderId) return;
    const section = document.createElement("section");
    section.className = "panel account-panel account-sessions";
    section.innerHTML = `<h3>管理会话</h3>${sessions.items.map(session => `<div class="section-intro"><div><strong data-no-translate>${escapeHtml(session.client_type)}</strong> ${session.current ? "<span>当前会话</span>" : ""}<p class="helper" data-no-translate>${escapeHtml(session.user_agent || "")}</p><small>${formatDate(session.created_at)}</small></div><button class="button button-secondary" data-revoke-session="${escapeHtml(session.id)}">退出此会话</button></div>`).join("")}`;
    viewContent.append(section);
    section.addEventListener("click", async event => {
      const button = event.target.closest("[data-revoke-session]");
      if (!button || button.disabled) return;
      button.disabled = true;
      try {
        await api(`/api/v2/auth/sessions/${encodeURIComponent(button.dataset.revokeSession)}`, { method: "DELETE" });
        if (sessions.items.find(item => item.id === button.dataset.revokeSession)?.current) {
          window.dispatchEvent(new CustomEvent("session-expired"));
        } else {
          await renderAccount(state.renderId);
        }
      } catch (error) {
        toast(error.message, "error");
        button.disabled = false;
      }
    });
  }
  return { renderSecurity };
}
