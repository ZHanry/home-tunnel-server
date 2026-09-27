import { test, expect } from "@playwright/test";

async function untranslated(page, selector = "#view-content") {
  return page.locator(selector).evaluate((root) => {
    const findings = [];
    const excluded = "script,style,code,[data-no-translate],[translate=no],[data-locale-toggle]";
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (/[\u3400-\u9fff]/.test(node.nodeValue) && !node.parentElement.closest(excluded)
          && node.parentElement.getClientRects().length) findings.push(node.nodeValue.trim());
    }
    for (const element of root.querySelectorAll("*")) {
      if (element.closest(excluded) || !element.getClientRects().length) continue;
      for (const name of ["aria-label", "title", "placeholder", "data-label"]) {
        const value = element.getAttribute(name);
        if (value && /[\u3400-\u9fff]/.test(value)) findings.push(`${name}: ${value}`);
      }
    }
    return findings;
  });
}

test.beforeEach(async ({ request }) => { await request.post("/__preview/reset"); });

test("public landing copy and footer translate in both directions", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("ht_locale", "en"));
  await page.goto("/");
  await expect(page.locator("#landing-screen")).toBeVisible();
  await expect.poll(() => untranslated(page, "#landing-screen")).toEqual([]);
  await expect(page.getByRole("heading", { name: "Mobile remote management" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Get started", exact: true })).toBeVisible();
  await page.locator(".marketing-footer [data-locale-toggle]").click();
  await expect(page.getByRole("heading", { name: "手机远程管理" })).toBeVisible();
  await expect(page.getByRole("link", { name: "开始使用", exact: true })).toBeVisible();
});

test("audit events keep labels and action identifiers readable on phones and tablets", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ht_locale", "en"));
  for (const width of [390, 834, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    await page.goto("/admin#audit");
    await expect(page.locator("#view-content")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator(".audit-table-panel .data-table")).toBeVisible();
    const layout = await page.locator(".audit-table-panel").evaluate((panel) => {
      const actions = [...panel.querySelectorAll("td:nth-child(2) .cell-primary")];
      return {
        pageFits: document.documentElement.scrollWidth <= innerWidth,
        actionLines: actions.map((action) => {
          const range = document.createRange();
          range.selectNodeContents(action);
          return range.getClientRects().length;
        }),
        fieldsFit: [...panel.querySelectorAll("td")].every((cell) => cell.scrollWidth <= cell.clientWidth + 1),
      };
    });
    expect(layout.pageFits, `page width ${width}`).toBe(true);
    expect(layout.fieldsFit, `audit values at ${width}`).toBe(true);
    expect(layout.actionLines.length).toBeGreaterThan(0);
    expect(layout.actionLines.every((lines) => lines === 1), `audit actions at ${width}`).toBe(true);
    await expect.poll(() => untranslated(page)).toEqual([]);
  }
});

test("English navigation pages localize product text while preserving user content", async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => localStorage.setItem("ht_locale", "en"));
  await page.route("**/api/v1/auth/mfa", (route) => route.fulfill({ json: { enabled: true, recovery_codes_remaining: 7 } }));
  await page.route("**/api/v1/auth/sessions", (route) => route.fulfill({ json: { items: [{
    id: "current", client_type: "web", user_agent: "用户定义的客户端名称", current: true,
    created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-27T00:00:00Z",
  }], has_more: true } }));
  await page.route("**/api/v1/client/enrollment-codes", (route) => route.fulfill({ json: { items: [{
    id: "personal-note", name: "添加验证器", expires_at: "2026-10-01T00:00:00Z",
  }] } }));
  for (const role of ["admin", "user"]) for (const view of ["dashboard", "users", "devices", "connections", "remote", "audit", "settings", "updates", "account"]) {
    if (role === "user" && ["users", "audit", "settings"].includes(view)) continue;
    await page.goto(`/admin?role=${role}#${view}`);
    await expect(page.locator("#app-shell")).toBeVisible();
    await expect(page.locator("#view-content")).toHaveAttribute("aria-busy", "false");
    await expect.poll(() => untranslated(page), { message: `${role}/${view} product copy` }).toEqual([]);
  }
  await expect(page.locator("#view-content")).toContainText("Recovery codes remaining: 7");
  await expect(page.locator("#view-content [data-no-translate]", { hasText: "添加验证器" })).toHaveText("添加验证器");
  await page.locator(".sidebar [data-locale-toggle]").click();
  await expect(page.locator("#view-content")).toContainText("剩余恢复码 7 个");
  await expect(page.locator("#view-content")).toContainText("每月按 UTC 自然月重置");
  await expect(page.locator("#view-content")).toContainText("管理会话");
  await page.locator(".sidebar [data-locale-toggle]").click();
  await expect.poll(() => untranslated(page)).toEqual([]);
});

test("account enrollment and authenticator dialogs use the selected language", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ht_locale", "en"));
  await page.goto("/admin?role=user#account");
  await expect(page.locator("#view-content")).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "Add authenticator", exact: true }).click();
  await expect(page.locator("#modal")).toBeVisible();
  await expect.poll(() => untranslated(page, "#modal")).toEqual([]);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Generate enrollment code", exact: true }).click();
  await expect(page.locator("#modal")).toBeVisible();
  await expect.poll(() => untranslated(page, "#modal")).toEqual([]);
});

test("network failures follow English and Chinese without losing the retry action", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ht_locale", "en"));
  await page.route(/\/api\/v1\/admin\/users(?:\?|$)/, (route) => route.abort("internetdisconnected"));
  await page.goto("/admin#users");
  await expect(page.locator("#view-content")).toContainText("Unable to connect to the server");
  await expect(page.locator("#view-content").getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await expect.poll(() => untranslated(page)).toEqual([]);
  await page.locator(".sidebar [data-locale-toggle]").click();
  await expect(page.locator("#view-content")).toContainText("无法连接服务器，请检查网络后重试");
  await expect(page.locator("#view-content").getByRole("button", { name: "重试", exact: true })).toBeVisible();
});
