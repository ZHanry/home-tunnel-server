import { test, expect } from "@playwright/test";

const hosts = Array.from({ length: 5 }, (_, index) => ({
  id: `10000000-0000-4000-8000-00000000000${index}`, name: `测试电脑 ${index + 1}`, role: "host",
  platform: "windows", status: "active", online: true, local_enabled: true,
  capabilities: { status: "ready", permissions: ["view", "input.keyboard", "input.text", "clipboard.read", "files.receive"], displays: [{ id: "display-1", name: "主屏幕", width: 1920, height: 1080 }] },
}));
async function ready(page, items = hosts) {
  await page.route("**/api/v1/public/capabilities", (route) => route.fulfill({ json: { remote_desktop: { enabled: true, stun_urls: ["stun:stun.example.test:3478"] } } }));
  await page.route("**/api/v1/rd/endpoints?**", (route) => route.fulfill({ json: { items } }));
  await page.goto("/admin#remote");
  await expect(page.locator("#view-content")).toHaveAttribute("aria-busy", "false");
}
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

test("legacy servers show an explicit unavailable state without requesting a remote session", async ({ page }) => {
  let remoteRequests = 0;
  await page.route("**/api/v1/rd/**", (route) => { remoteRequests++; return route.fulfill({ status: 404 }); });
  await page.route("**/api/v1/public/capabilities", (route) => route.fulfill({ json: { contract_version: "1.1.0" } }));
  await page.goto("/admin#remote");
  await expect(page.locator("#view-content")).toContainText("远程桌面尚未启用");
  expect(remoteRequests).toBe(0);
});

test("offline and missing-backend hosts cannot start a remote desktop", async ({ page }) => {
  await ready(page, [{ ...hosts[0], online: false }, { ...hosts[1], capabilities: { ...hosts[1].capabilities, status: "unavailable" } }]);
  for (const button of await page.locator("[data-remote-host]").all()) await expect(button).toBeDisabled();
});

test("four independent windows retain drafts and closing one preserves the others", async ({ page }) => {
  await ready(page);
  // Opening a dialog is a local operation; no authentication or media is mocked as successful.
  for (let index = 0; index < 4; index++) await page.locator(`[data-remote-host="${hosts[index].id}"]`).evaluate((button) => button.click());
  await expect(page.locator(".remote-dialog")).toHaveCount(4);
  await page.locator(`[data-remote-host="${hosts[4].id}"]`).evaluate((button) => button.click());
  await expect(page.locator(".remote-dialog")).toHaveCount(4);
  const first = page.getByRole("dialog", { name: "远程桌面：测试电脑 1", exact: true });
  await first.locator('[name="mfa"]').evaluate((input) => { input.value = "draft"; });
  await page.getByRole("dialog", { name: "远程桌面：测试电脑 4", exact: true }).locator("[data-close]").click();
  await expect(page.locator(".remote-dialog")).toHaveCount(3);
  await expect(first.locator('[name="mfa"]')).toHaveValue("draft");
  await expect(page.locator(".remote-window-switch")).toHaveCount(3);
});

test("reauthentication failure clears secrets and never enrolls the browser", async ({ page }) => {
  let enrollments = 0;
  await ready(page, [hosts[0]]);
  await page.route("**/api/v1/rd/reauth", (route) => route.fulfill({ status: 403, json: { error_code: "RD_REAUTH_REQUIRED", message: "密码验证失败" } }));
  await page.route("**/api/v1/rd/enrollment-challenges", (route) => { enrollments++; return route.fulfill({ status: 500 }); });
  await page.locator("[data-remote-host]").click();
  const dialog = page.locator(".remote-dialog");
  await dialog.locator('[name="password"]').fill("not-a-real-secret");
  await dialog.locator(".remote-auth button[type=submit]").click();
  await expect(dialog.locator(".remote-error")).toContainText("密码验证失败");
  await expect(dialog.locator('[name="password"]')).toHaveValue("");
  await expect(dialog.locator(".remote-viewer")).toBeHidden();
  expect(enrollments).toBe(0);
});

test("account expiration removes every remote window and switcher", async ({ page }) => {
  await ready(page);
  await page.locator("[data-remote-host]").first().click();
  await page.evaluate(() => window.dispatchEvent(new Event("home-tunnel:session-expired")));
  // Use the same public authentication-failure path as the existing console suite.
  await page.route("**/api/v1/admin/users", (route) => route.fulfill({ status: 401, json: { error_code: "SESSION_REVOKED" } }));
  await page.route("**/api/v1/auth/refresh", (route) => route.fulfill({ status: 401, json: { error_code: "SESSION_REVOKED" } }));
  await page.locator('[data-view="users"]').evaluate((button) => button.click());
  await expect(page.locator("#auth-screen")).toBeVisible();
  await expect(page.locator(".remote-dialog")).toHaveCount(0);
  await expect(page.locator(".remote-window-bar")).toHaveCount(0);
});

test("a nonmodal viewer remains scrollable at 720px with file and clipboard panels", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await ready(page, [hosts[0]]); await page.locator("[data-remote-host]").click();
  // Layout-only fixture. It does not claim that capture or a media session works.
  await page.locator(".remote-dialog").evaluate((dialog) => {
    dialog.querySelector(".remote-auth").hidden = true; dialog.querySelector(".remote-viewer").hidden = false;
    dialog.querySelector("[data-clipboard-panel]").hidden = false; dialog.querySelector("[data-file-panel]").hidden = false;
  });
  const button = page.locator("[data-file-send]"); await button.scrollIntoViewIfNeeded();
  await expect(button).toBeInViewport();
  expect(await page.locator(".remote-dialog").evaluate((dialog) => dialog.scrollTop)).toBeGreaterThan(0);
});
