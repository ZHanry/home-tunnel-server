import { test, expect } from "@playwright/test";

test.beforeEach(async ({ request }) => { await request.post("/__preview/reset"); });

const host = {
  id: "10000000-0000-4000-8000-000000000001", name: "关闭", role: "host", platform: "Windows",
  status: "active", online: true, local_enabled: true,
  capabilities: { status: "ready", unattended_enabled: true,
    permissions: ["view", "input.keyboard", "input.pointer", "input.text", "clipboard.read", "clipboard.write", "files.send", "files.receive", "audio.system"],
    displays: [{ id: "main", name: "主屏幕", width: 1920, height: 1080 }] },
};

async function prepare(page, preference, systemDark) {
  await page.context().addInitScript(({ preference }) => {
    if (location.protocol !== "http:") return;
    localStorage.setItem("ht_locale", "en"); localStorage.setItem("ht_theme", preference);
  }, { preference });
  await page.emulateMedia({ colorScheme: systemDark ? "dark" : "light" });
  await page.context().route("**/api/v1/public/capabilities", route => route.fulfill({ json: { remote_desktop: { enabled: true, stun_urls: [] } } }));
  await page.context().route("**/api/v1/rd/endpoints?**", route => route.fulfill({ json: { items: [host] } }));
  // Exercise the production connection forms, without creating a signed session.
  await page.context().route("**/modules/remote/http.js", route => route.fulfill({ contentType: "text/javascript", body: `
    export class RemoteError extends Error { constructor(code) { super(code); this.code = code; } }
    export class RemoteApi {
      constructor() { this.userId = "fixture"; this.identity = {}; }
      assertCurrent() {}
      async initialize() { if (!location.search.includes("remoteAssist")) throw new RemoteError("RD_RECENT_AUTH_REQUIRED"); }
      async request() { throw new RemoteError("RD_ACCESS_INVALID"); }
      close() {}
    }
  ` }));
  await page.context().route("**/modules/remote/signal.js", route => route.fulfill({ contentType: "text/javascript", body: "export class RemoteSignal { async connect() {} close() {} }" }));
  await page.goto("/admin#remote");
  await expect(page.locator("#view-content")).toHaveAttribute("aria-busy", "false");
}

async function untranslated(root) {
  return root.evaluate(element => {
    const result = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.parentElement.closest("script,style,[data-no-translate]") && /\p{Script=Han}/u.test(node.textContent)) result.push(node.textContent);
    }
    return result;
  });
}

test.afterEach(async ({ context }) => { await context.unrouteAll({ behavior: "wait" }); });

for (const [preference, systemDark, expectedTheme] of [["light", true, "light"], ["dark", false, "dark"], ["system", true, "dark"], ["system", false, "light"]]) {
  test(`remote popout uses ${preference} with system ${systemDark ? "dark" : "light"} and translates product copy`, async ({ page }) => {
    await prepare(page, preference, systemDark);
    const opening = page.waitForEvent("popup");
    await page.locator("[data-remote-host]").click();
    const popup = await opening;
    await popup.emulateMedia({ colorScheme: systemDark ? "dark" : "light" });
    await popup.setViewportSize({ width: 390, height: 844 });
    const dialog = popup.locator(".remote-dialog");
    await expect(dialog.locator(".remote-auth")).toBeVisible();
    await expect(dialog.locator(".remote-status")).toHaveText("Verify your account before the first connection");
    await expect(dialog.locator("h2")).toHaveText(host.name);
    await expect(dialog.locator("[data-close]")).toHaveText("Close window");
    await expect(popup.locator("html")).toHaveAttribute("data-theme", expectedTheme);
    await expect.poll(() => untranslated(dialog)).toEqual([]);
    const layout = await dialog.evaluate(element => {
      const close = element.querySelector("[data-close]").getBoundingClientRect();
      return { background: getComputedStyle(element).backgroundColor,
        pageBackground: getComputedStyle(document.documentElement).backgroundColor,
        width: element.clientWidth, scrollWidth: element.scrollWidth, closeRight: close.right,
        closeLeft: close.left, height: close.height };
    });
    expect(layout.background).toBe(layout.pageBackground);
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width);
    expect(layout.closeRight).toBeLessThanOrEqual(layout.width + 1);
    expect(layout.closeLeft).toBeGreaterThanOrEqual(0);
    expect(layout.height).toBeGreaterThanOrEqual(44);
    await popup.close();
  });
}

test("remote account failures remain visible while narrow and short windows scroll permissions", async ({ page }) => {
  await prepare(page, "dark", true);
  await page.context().route("**/api/v1/rd/reauth", route => route.fulfill({ status: 401, json: { error_code: "AUTH_INVALID", message: "账号验证失败" } }));
  const opening = page.waitForEvent("popup");
  await page.locator("[data-remote-host]").click();
  const popup = await opening;
  await popup.setViewportSize({ width: 390, height: 844 });
  const form = popup.locator(".remote-auth");
  await form.locator('[name="password"]').fill("Fixture-Password!1234");
  await form.locator("button[type=submit]").click();
  const error = popup.locator(".remote-error");
  await expect(error).toHaveText("Authentication failed");
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await popup.setViewportSize(viewport);
    await form.evaluate(element => element.scrollTo(0, element.scrollHeight));
    await expect(form.locator("button[type=submit]")).toBeInViewport();
    const layout = await popup.locator(".remote-dialog").evaluate(dialog => {
      const header = dialog.querySelector(".remote-header").getBoundingClientRect();
      const message = dialog.querySelector(".remote-error").getBoundingClientRect();
      const form = dialog.querySelector(".remote-auth");
      const bounds = form.getBoundingClientRect();
      return { headerBottom: header.bottom, messageTop: message.top, messageBottom: message.bottom,
        formTop: bounds.top, formBottom: bounds.bottom, scrollTop: form.scrollTop,
        dialogScroll: dialog.scrollTop, height: innerHeight };
    });
    expect(layout.messageTop).toBeGreaterThanOrEqual(layout.headerBottom);
    expect(layout.messageBottom).toBeLessThanOrEqual(layout.formTop);
    expect(layout.formBottom).toBeLessThanOrEqual(layout.height + 1);
    expect(layout.scrollTop).toBeGreaterThan(0);
    expect(layout.dialogScroll).toBe(0);
    await expect(popup.locator("[data-close]")).toBeInViewport();
    await popup.locator("[data-close]").focus();
    await popup.keyboard.press("Tab");
    await expect(form.locator('[name="password"]')).toBeFocused();
    await expect(form.locator('[name="password"]')).toBeInViewport();
  }
  await popup.close();
});

test("remote MFA focuses its field and follows account language changes without translating the host name", async ({ page }) => {
  await prepare(page, "light", false);
  await page.context().route("**/api/v1/rd/reauth", route => route.fulfill({ status: 401, json: { error_code: "MFA_REQUIRED", message: "请输入动态码或恢复码" } }));
  const opening = page.waitForEvent("popup");
  await page.locator("[data-remote-trust]").click();
  const popup = await opening;
  const dialog = popup.locator(".remote-dialog");
  await dialog.locator('[name="password"]').fill("Fixture-Password!1234");
  await dialog.locator("button[type=submit]").click();
  await expect(dialog.locator('[name="mfa"]')).toBeFocused();
  await expect(dialog.locator(".remote-status")).toHaveText("Enter your authenticator or recovery code");
  await expect.poll(() => untranslated(dialog)).toEqual([]);
  await page.locator("#app-shell [data-locale-toggle]:visible").first().click();
  await expect(dialog.locator("[data-close]")).toHaveText("关闭窗口");
  await expect(dialog.locator("h2")).toHaveText(host.name);
  await page.locator("#app-shell [data-locale-toggle]:visible").first().click();
  await expect(dialog.locator("[data-close]")).toHaveText("Close window");
  await expect(dialog.locator("h2")).toHaveText(host.name);
  await popup.close();
});

test("device-code forms hide unused credentials and localize all connection methods and failures", async ({ page }) => {
  await prepare(page, "light", false);
  const opening = page.waitForEvent("popup");
  await page.locator("[data-remote-assist]").click();
  const popup = await opening;
  const panel = popup.locator(".remote-assist-entry");
  await expect(panel.locator('[name="password"]')).toBeHidden();
  await expect.poll(() => untranslated(panel)).toEqual([]);
  for (const mode of ["fixed", "temporary"]) {
    await panel.locator('[name="access_mode"]').selectOption(mode);
    await panel.locator('[name="device_id"]').fill("123456789");
    await panel.locator('[name="password"]').fill("Fixture-Password!1234");
    await panel.locator("button[type=submit]").click();
    await expect(panel.locator("[data-assist-error]")).toHaveText("The device ID or connection credentials are invalid, or connections to this device are paused.");
    await expect(panel.locator('[name="password"]')).toHaveValue("");
    await expect.poll(() => untranslated(panel)).toEqual([]);
  }
  await panel.locator('[name="access_mode"]').selectOption("request");
  await expect(panel.locator('[name="password"]')).toBeHidden();
  await popup.close();
});

test("device-code form accepts a grouped ID and is prefilled by the desktop client", async ({ page }) => {
  await prepare(page, "light", false);
  const popup = await page.context().newPage();
  const sent = [];
  await popup.route("**/modules/remote/http.js", route => route.fulfill({ contentType: "text/javascript", body: `
    export class RemoteError extends Error { constructor(code) { super(code); this.code = code; } }
    export class RemoteApi {
      constructor() { this.userId = "fixture"; this.identity = {}; }
      assertCurrent() {}
      async initialize() {}
      async request(path, options) { window.__sent = [...(window.__sent || []), { path, body: options?.body }]; throw new RemoteError("RD_ACCESS_INVALID"); }
      close() {}
    }
  ` }));
  await popup.goto("/admin?remoteAssist=1&remoteAccessId=482913570#remote");
  const panel = popup.locator(".remote-assist-entry");
  await expect(panel.locator('[name="device_id"]')).toHaveValue("482 913 570");
  await panel.locator('[name="device_id"]').fill("12345");
  await panel.locator("button[type=submit]").click();
  await expect(panel.locator("[data-assist-error]")).toHaveText("The device ID must be 9 digits.");
  await panel.locator('[name="device_id"]').fill(" 123 456-789 ");
  await panel.locator("button[type=submit]").click();
  await expect(panel.locator("[data-assist-error]")).toHaveText(/invalid/);
  sent.push(...await popup.evaluate(() => window.__sent));
  expect(sent).toEqual([{ path: "/api/v1/rd/access/requests", body: { device_id: "123456789" } }]);
  await popup.close();
});
