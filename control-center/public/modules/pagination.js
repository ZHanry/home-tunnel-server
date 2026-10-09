import { t } from "./locale.js?v=13.0.0";

export function pagination({ page = 1, pages = 1, total = 0, pageSize = 20, action, label }) {
  page = Math.max(1, Math.floor(Number(page) || 1));
  pages = Math.max(1, Math.floor(Number(pages) || 1));
  total = Math.max(0, Math.floor(Number(total) || 0));
  const first = total ? (page - 1) * pageSize + 1 : 0;
  const last = Math.min(total, page * pageSize);
  return `<footer class="pagination panel" aria-label="${label}"><span>${t(`显示 ${first}–${last}，共 ${total} 条`, `${first}–${last} of ${total}`)}</span><div><button class="button button-secondary button-small" data-action="${action}" data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>${t("上一页", "Previous")}</button><span class="pagination-current" data-no-translate>${page} / ${pages}</span><button class="button button-secondary button-small" data-action="${action}" data-page="${page + 1}" ${page >= pages ? "disabled" : ""}>${t("下一页", "Next")}</button></div></footer>`;
}
