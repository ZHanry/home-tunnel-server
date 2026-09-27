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

test("quota policies and applied tunnel versions localize on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("ht_locale", "en"));
  await page.goto("/admin#users");
  await page.locator('[data-action="user-policy"]').first().click();
  await expect.poll(() => untranslated(page, "#modal")).toEqual([]);
  await expect(page.locator("#modal")).toContainText("TCP/UDP traffic is excluded");
  await page.keyboard.press("Escape");
  await page.goto("/admin?role=user#connections");
  const action = page.locator('[data-action="connection-details"]').first();
  await action.click();
  await expect(page.locator("#modal-title")).toHaveText("Connection details · NAS 控制台");
  await expect.poll(() => untranslated(page, "#modal-body")).toEqual([]);
  await expect(page.locator("#modal")).toContainText("Applied 12 / Target 12");
});

test("forced password change localizes MFA and focuses the code when verification fails", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("ht_locale", "en"));
  for (const endpoint of ["session", "refresh"]) await page.route(`**/api/v1/auth/${endpoint}`, route => route.fulfill({ status: 401, json: { error_code: "SESSION_REVOKED" } }));
  await page.route("**/api/v1/auth/login", route => route.fulfill({ json: { password_change_required: true, csrf_token: "fixture" } }));
  await page.route("**/api/v1/auth/password/change", route => route.fulfill({ status: 401, json: { error_code: "MFA_INVALID", message: "动态码无效" } }));
  await page.goto("/admin");
  await page.locator("#login-username").fill("review-member");
  await page.locator("#login-password").fill("Temporary-Review!1234");
  await page.locator("#login-form button[type=submit]").click();
  await expect(page.locator("#password-form:not(.hidden)")).toBeVisible();
  await expect.poll(() => untranslated(page, "#password-form")).toEqual([]);
  await page.locator("#new-password").fill("New-Review-Password!1234");
  await page.locator("#confirm-password").fill("New-Review-Password!1234");
  await page.keyboard.press("Tab");
  await expect(page.locator("#password-mfa")).toBeFocused();
  await page.locator("#password-mfa").fill("123456");
  await page.keyboard.press("Tab");
  await expect(page.locator("#password-form button[type=submit]")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#password-mfa")).toBeFocused();
  await expect(page.locator("#password-mfa")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#new-password")).not.toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#password-error")).toHaveText("The authenticator or recovery code is invalid; try again");
});

test("confirmation dialogs localize their consequences and preserve the selected resource", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("ht_locale", "en"));
  for (const [view, action] of [["users", "reset-password"], ["users", "delete-user"], ["users", "toggle-user"], ["devices", "delete-device"], ["connections", "delete-connection"]]) {
    await page.goto(`/admin#${view}`);
    await expect(page.locator("#view-content")).toHaveAttribute("aria-busy", "false");
    const button = page.locator(`[data-action="${action}"]`).first();
    const menu = button.locator("xpath=ancestor::details");
    if (await menu.count()) await menu.locator("summary").click();
    await button.click();
    await expect(page.locator("#modal[open]")).toBeVisible();
    await expect.poll(() => untranslated(page, "#modal")).toEqual([]);
    const subject = await page.locator(".confirmation-notice [data-no-translate]").innerText();
    expect(subject).not.toBe("");
    const geometry = await page.locator(".confirmation-notice").evaluate(element => {
      const [title, name, consequence] = [...element.children].map(child => child.getBoundingClientRect());
      return title.bottom <= name.top && name.bottom <= consequence.top;
    });
    expect(geometry, `${action} readable confirmation`).toBe(true);
    for (const locale of ["zh-CN", "en"]) {
      await page.evaluate(async locale => (await import("/modules/locale.js?v=9.0.0")).applyLocale(locale), locale);
      await expect(page.locator(".confirmation-notice [data-no-translate]")).toHaveText(subject);
    }
    await expect.poll(() => untranslated(page, "#modal")).toEqual([]);
    await page.keyboard.press("Escape");
  }
});

test("batch confirmations and one-time credentials remain legible in English", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("ht_locale", "en"));
  for (const enabled of [false, true]) {
    await page.goto("/admin?role=user#connections");
    await expect(page.locator("#view-content")).toHaveAttribute("aria-busy", "false");
    await page.locator("[data-select-connection]").first().check();
    await page.locator(`[data-action="batch-connections"][data-enabled="${enabled}"]`).click();
    await expect.poll(() => untranslated(page, "#modal")).toEqual([]);
    await expect(page.locator("#modal-body li[data-no-translate]")).toContainText("NAS 控制台");
    await page.keyboard.press("Escape");
  }
  const code = "Review-Only-1234-5678";
  await page.route("**/api/v1/client/enrollment-codes", async route => {
    if (route.request().method() === "POST") return route.fulfill({ json: { id: "fixture", code, expires_at: "2026-09-27T12:10:00Z" } });
    return route.continue();
  });
  await page.goto("/admin?role=user#account");
  await page.locator('[data-security="enrollment"]').click();
  await page.locator('#modal button[type="submit"]').click();
  await expect(page.locator(".secret-value")).toHaveText(code);
  const geometry = await page.locator(".secret-box").evaluate(element => {
    const label = element.querySelector("strong").getBoundingClientRect();
    const secret = element.querySelector(".secret-value").getBoundingClientRect();
    return label.bottom < secret.top && secret.right <= element.getBoundingClientRect().right;
  });
  expect(geometry, "credential is distinct from its advisory label").toBe(true);
  await expect.poll(() => untranslated(page, "#modal")).toEqual([]);
});

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
  await page.getByRole("button", { name: "Change password", exact: true }).click();
  await expect.poll(() => untranslated(page, "#modal")).toEqual([]);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Add authenticator", exact: true }).click();
  await expect(page.locator("#modal")).toBeVisible();
  await expect.poll(() => untranslated(page, "#modal")).toEqual([]);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Generate enrollment code", exact: true }).click();
  await expect(page.locator("#modal")).toBeVisible();
  await expect.poll(() => untranslated(page, "#modal")).toEqual([]);
});

test("empty collection pages localize their onboarding and recovery instructions", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ht_locale", "en"));
  await page.route(/\/api\/v1\/(admin|client)\/(connections|devices|users|audit-events)(?:\?|$)/, async route => {
    const response = await route.fetch();
    const body = await response.json();
    expect(Array.isArray(body.items)).toBe(true);
    await route.fulfill({ json: { ...body, items: [], total: 0, page: 1, total_pages: 1 } });
  });
  for (const role of ["admin", "user"]) for (const view of ["dashboard", "users", "devices", "connections", "audit"]) {
    if (role === "user" && ["users", "audit"].includes(view)) continue;
    await page.goto(`/admin?role=${role}#${view}`);
    await expect(page.locator("#view-content")).toHaveAttribute("aria-busy", "false");
    await expect.poll(() => untranslated(page), { message: `${role}/${view} empty instructions` }).toEqual([]);
  }
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
