import { test, expect } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  await request.post("/__preview/reset");
});
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});
const ready = async (page, path = "/admin#connections") => {
  await page.goto(path);
  await expect(page.locator("#app-shell")).toBeVisible();
  await expect(page.locator("#view-content")).toHaveAttribute("aria-busy", "false");
};

test("an empty audit result clears stale page counts and disables pagination", async ({ page }) => {
  await page.route(/\/api\/v1\/admin\/audit-events(?:\?|$)/, route => route.fulfill({ json: {
    items: [], total: 0, page: 3, page_size: 25, total_pages: 3,
  } }));
  await ready(page, "/admin#audit");
  await expect(page.locator(".pagination-current")).toHaveText("1 / 1");
  await expect(page.locator('[data-action="audit-page"]').first()).toBeDisabled();
  await expect(page.locator('[data-action="audit-page"]').last()).toBeDisabled();
  await expect(page.locator(".audit-table-panel")).toContainText("显示 0–0，共 0 条");
});

test("a phone user can cancel sign-out or confirm it from the account page", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let signOutRequests = 0;
  page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v2/auth/logout") signOutRequests++; });
  await ready(page, "/admin?role=user#account");
  const action = page.locator('[data-action="logout"]');
  await action.click();
  await expect(page.locator("#modal[open]")).toBeVisible();
  expect(signOutRequests).toBe(0);
  await page.locator("[data-modal-cancel]").click();
  await expect(page.locator("#app-shell")).toBeVisible();
  await action.click();
  await page.locator('#modal button[type="submit"]').click();
  await expect(page.locator("#auth-screen")).toBeVisible();
  expect(signOutRequests).toBe(1);
});

test("public home and return link work without a session", async ({ page }) => {
  await page.route("**/api/v2/auth/refresh", (route) =>
    route.fulfill({ status: 401, json: { error_code: "SESSION_REVOKED" } }),
  );
  await page.goto("/");
  await expect(page.locator("#landing-screen")).toBeVisible();
  await page.goto("/admin");
  await expect(page.locator("#auth-screen")).toBeVisible();
  await page.locator(".auth-home-link").click();
  await expect(page.locator("#landing-screen")).toBeVisible();
});

test("public home keeps prototype artwork, features and language on narrow screens", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator(".marketing-brand .brand-mark img")).toBeVisible();
  await expect(page.locator(".marketing-brand")).toContainText("NestLink");
  await expect(page.locator(".hero-art .art-server")).toBeVisible();
  await expect(page.locator(".landing-features article")).toHaveCount(3);
  await expect(page.locator("#hero-download")).toHaveAttribute(
    "href",
    "https://github.com/ZHanry/home-tunnel-client/releases/tag/v14.0.0",
  );
  await page.locator(".marketing-footer [data-locale-toggle]").click();
  await expect(page.locator("#hero-title")).toContainText("Bring your home services");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("dashboard uses the shared header and navigation actions and fits a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page, "/admin#dashboard");
  await expect(page.locator(".overview-metric")).toHaveCount(4);
  await expect(page.locator('#page-actions [data-action="create-connection"]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.nav-primary[data-view="remote"]').click();
  await expect(page).toHaveURL(/#remote$/);
});

test("password failures never expose obsolete authentication inputs or auto-retry", async ({ page }) => {
  await page.route("**/api/v2/auth/refresh", route => route.fulfill({ status: 401, json: { error_code: "SESSION_REVOKED" } }));
  const attempts = [];
  await page.route("**/api/v2/auth/login", route => {
    attempts.push(route.request().postDataJSON());
    return route.fulfill({ status: 401, json: { error_code: "AUTH_INVALID", message: "账号或密码错误" } });
  });
  await page.goto("/admin");
  await page.locator("#login-username").fill("test-user");
  await page.locator("#login-password").fill("wrong-password");
  await page.locator("#login-form button[type=submit]").click();
  await expect(page.locator("#login-error")).not.toBeEmpty();
  expect(attempts).toHaveLength(1);
  expect(Object.keys(attempts[0]).sort()).toEqual(["client_type", "password", "username"]);
  await expect(page.locator("#login-mfa-step,#login-mfa,[name=mfa_code]")).toHaveCount(0);
  await page.locator("#login-password").fill("new-password");
  await expect(page.locator("#login-error")).toBeEmpty();
  expect(attempts).toHaveLength(1);
  await page.locator("#login-form button[type=submit]").click();
  await expect.poll(() => attempts.length).toBe(2);
});

test("remote page requests browser control using the account and clears its password", async ({ page }) => {
  const requests = [];
  await page.route("**/api/v2/browser/config", route => route.fulfill({ json: { stun_urls: [] } }));
  await page.route("**/api/v2/browser/sessions", async route => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status: 409, json: { error_code: "BROWSER_HOST_OFFLINE", message: "被控设备离线" } });
  });
  await ready(page, "/admin#remote");
  await expect(page.locator('a[href^="homedesk://"]')).toHaveCount(0);
  await page.locator("#remote-target-id").fill("123456789");
  await page.locator("#remote-password").fill("test-only-password");
  await page.locator("#remote-connect-form button[type=submit]").click();
  await expect(page.locator(".browser-remote-dialog canvas")).toBeVisible();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].target_id).toBe("123456789");
  expect(requests[0].password).toBe("test-only-password");
  await expect(page.locator("#remote-password")).toHaveValue("");
  await expect(page.locator(".browser-remote-dialog [data-remote-status]")).toContainText("被控设备离线");
  await page.locator(".browser-remote-dialog [data-close]").click();
  await expect(page.locator(".browser-remote-dialog")).toHaveCount(0);
});

test("sidebar version opens official release details in a dialog", async ({ page }) => {
  await ready(page, "/admin#connections");
  await expect(page.locator('[data-view="updates"]')).toHaveCount(0);
  await page.locator("#version-button").click();
  await expect(page.locator("#modal[open]")).toBeVisible();
  await expect(page.locator("#modal")).toContainText("14.0.0");
  await expect(page.locator("#modal .update-summary")).toContainText("NestLink");
  await expect(page.locator('#modal a[href*="github.com/ZHanry/home-tunnel-server/releases"]')).toBeVisible();
});

test("account deletion describes affected resources, supports cancellation and sends its version", async ({
  page,
}) => {
  await ready(page, "/admin#users");
  await page.locator(".person-row .more-actions summary").first().click();
  await page.locator('[data-action="delete-user"]').first().click();
  await expect(page.locator("#modal")).toContainText("所有设备凭据和会话将撤销");
  await page.locator("#modal [data-modal-cancel]").click();
  await expect(page.locator(".person-row")).toHaveCount(2);
  await page.locator('[data-action="delete-user"]').first().click();
  const request = page.waitForRequest(
    (r) => r.method() === "DELETE" && r.url().includes("/admin/users/"),
  );
  await page.locator('#modal button[type="submit"]').click();
  expect((await request).postDataJSON().expected_version).toBe(1);
  await expect(page.locator(".person-row")).toHaveCount(1);
  await expect(page.locator("#toast-region")).toContainText("用户已删除");
});

test("theme and locale preferences persist without translating resource names", async ({ page }) => {
  await page.route("**/api/v1/admin/connections?**", async (route) => {
    const data = await (await route.fetch()).json();
    data.items[0].name = "在线";
    await route.fulfill({ json: data });
  });
  await page.emulateMedia({ colorScheme: "light" });
  await ready(page);
  const toggle = page.locator(".product-bar [data-theme-toggle]");
  await expect(toggle).toHaveAccessibleName("切换至深色主题");
  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme-preference", "dark");
  await expect(toggle).toHaveAccessibleName("切换至浅色主题");
  await page.locator(".product-bar [data-locale-toggle]").click();
  await expect(toggle).toHaveAccessibleName("Switch to light theme");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator(".connection-identity h3").first()).toHaveText("在线");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("#view-content")).toHaveAttribute("aria-busy", "false");
});

test("system theme and sidebar preferences synchronize across open tabs", async ({ page, context }) => {
  await page.emulateMedia({colorScheme: "dark"});
  await ready(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("#account-theme")).toHaveCount(0);
  const second = await context.newPage();
  await second.emulateMedia({colorScheme: "dark"});
  await ready(second, "/admin#account");
  await page.locator(".product-bar [data-theme-toggle]").click();
  await expect(second.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(second.locator(".product-bar [data-theme-toggle]")).toHaveAccessibleName("切换至深色主题");
  await page.evaluate(() => localStorage.removeItem("ht_theme"));
  await expect(second.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({colorScheme: "light"});
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await second.close();
});

test("integer bandwidth is accepted and saves with a version condition", async ({ page }) => {
  await ready(page, "/admin#users");
  await page.locator('[data-action="user-policy"]').first().click();
  const input = page.locator("#modal-bandwidth_mbps");
  await input.fill("50");
  expect(await input.evaluate((el) => el.checkValidity())).toBe(true);
  await input.fill("20");
  const write = page.waitForRequest(
    (r) => r.method() === "PATCH" && r.url().includes("traffic-policies"),
  );
  await page.locator("#modal button[type=submit]").click();
  expect((await write).postDataJSON().bandwidth_limit_bps).toBe(20_000_000);
  await expect(page.locator("#modal")).not.toBeVisible();
});

test("administrator can explicitly authorize client TCP and UDP creation", async ({ page }) => {
  await ready(page, "/admin#settings");
  const checkbox = page.locator("#client-raw-tunnels");
  await expect(checkbox).not.toBeChecked();
  await checkbox.check();
  const request = page.waitForRequest(
    (r) => r.method() === "PATCH" && r.url().endsWith("/admin/settings"),
  );
  await page.locator("#settings-form button[type=submit]").click();
  expect((await request).postDataJSON().client_raw_tunnels_enabled).toBe(true);
  await expect(page.locator("#toast-region")).toContainText("部署设置已保存");
  await page.reload();
  await expect(checkbox).toBeChecked();
});

test("background config events preserve input and focus", async ({ page }) => {
  await page.addInitScript(() => {
    const WS = window.WebSocket;
    window.auditSockets = [];
    window.WebSocket = class extends WS {
      constructor(...args) {
        super(...args);
        window.auditSockets.push(this);
      }
    };
  });
  await ready(page, "/admin#audit");
  await page.locator("#audit-query").fill("我的草稿");
  await page.evaluate(() =>
    window.auditSockets[0].dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify({ event: "config.version.changed" }) }),
    ),
  );
  await expect(page.locator("#sync-status")).toHaveCount(0);
  await expect(page.locator("#audit-query")).toHaveValue("我的草稿");
  await expect(page.locator("#audit-query")).toBeFocused();
});

test("expired refresh returns to login", async ({ page }) => {
  await ready(page);
  await page.route(/\/api\/v1\/admin\/users(?:\?|$)/, (route) =>
    route.fulfill({ status: 401, json: { error_code: "SESSION_REVOKED" } }),
  );
  await page.route("**/api/v2/auth/refresh", (route) =>
    route.fulfill({ status: 401, json: { error_code: "SESSION_REVOKED" } }),
  );
  await page.locator('[data-view="account"]').click();
  await page.locator('.administration-links [data-view="users"]').click();
  await expect(page.locator("#auth-screen")).toBeVisible();
  await expect(page.locator("#app-shell")).not.toBeVisible();
});

test("failed setting writes show feedback, preserve values and prevent double submit", async ({
  page,
}) => {
  await ready(page, "/admin#settings");
  let writes = 0;
  await page.route("**/api/v1/admin/settings", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    writes++;
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.fulfill({
      status: 500,
      json: { error_code: "INTERNAL_ERROR", message: "保存失败，请重试" },
    });
  });
  await page.locator("#prefix-policy").selectOption("enforce");
  await page.locator("#settings-form button").click();
  await expect(page.locator("#settings-form button")).toBeDisabled();
  await expect(page.locator("#toast-region")).toContainText("保存失败");
  await expect(page.locator("#prefix-policy")).toHaveValue("enforce");
  expect(writes).toBe(1);
});

test("unknown backup and degraded queue are never called normal", async ({ page }) => {
  await page.route("**/api/v1/admin/system/health", (route) =>
    route.fulfill({
      json: {
        status: "degraded",
        components: [
          { component: "backup", status: "unknown" },
          { component: "outbox", status: "degraded", pending: 4 },
          { component: "control-center", status: "healthy", latency_ms: 3 },
        ],
      },
    }),
  );
  await ready(page, "/admin#dashboard");
  await expect(page.locator(".health-rail-list")).toContainText("尚无备份记录");
  await expect(page.locator(".health-rail-list")).toContainText("需要处理");
  await page.locator(".product-bar [data-locale-toggle]").click();
  await expect(page.locator(".health-rail-list")).toContainText("Healthy · 3 ms");
  await expect(page.locator(".health-rail-list")).toContainText("Queued 4");
  await page.locator(".product-bar [data-locale-toggle]").click();
  await expect(page.locator(".health-rail-list")).toContainText("正常 · 3 ms");
  await expect(page.locator(".health-rail-list")).toContainText("待处理 4");
});

test("creation draft survives dismissal and owner without devices cannot submit", async ({
  page,
}) => {
  await page.route(/\/api\/v1\/admin\/users(?:\?|$)/, async (route) => {
    const data = await (await route.fetch()).json();
    data.items.push({
      id: "empty-owner",
      username: "empty",
      display_name: "无设备用户",
      status: "active",
    });
    await route.fulfill({ json: data });
  });
  await ready(page);
  await page.locator('[data-action="create-connection"]').click();
  await page.locator("#modal-name").fill("未提交的服务");
  await page.keyboard.press("Escape");
  await page.locator('[data-action="create-connection"]').click();
  await expect(page.locator("#modal-name")).toHaveValue("未提交的服务");
  await page.locator("#modal-user_id").selectOption("empty-owner");
  await expect(page.locator("#modal-device_id")).toHaveValue("");
  await expect(page.locator("#modal button[type=submit]")).toBeDisabled();
});

test("service wizard saves once and requires a device report before target verification", async ({ page }) => {
  await ready(page, "/admin?role=user#connections");
  let writes = 0, input, snapshot;
  const id = "b0000000-0000-4000-8000-000000000001";
  await page.route("**/api/v1/client/connections", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    writes++; input = route.request().postDataJSON();
    snapshot = { ...input, id, version: 1, applied_version: 1, state: "Online", public_url: "https://test.tunnel.example.com" };
    await route.fulfill({ status: 201, json: snapshot });
  });
  await page.route(`**/api/v1/client/connections/${id}`, (route) => route.fulfill({ json: snapshot }));
  await page.locator('[data-action="create-connection"]').click();
  await page.locator("#modal-name").fill("Secure NAS");
  await page.locator("#modal-client-preset").selectOption("https");
  await page.locator("#modal button[type=submit]").click();
  await expect(page.locator('[data-step="1"] h3')).toBeFocused();
  await expect(page.locator("#modal-local_port")).toHaveValue("443");
  await expect(page.locator("#modal-local_scheme")).toHaveValue("https");
  await page.locator("#modal-local_host").fill("192.168.10.8");
  await page.locator("#modal button[type=submit]").click();
  await page.locator("#modal button[type=submit]").click();
  expect(writes).toBe(0);
  await expect(page.locator("[data-tunnel-summary]")).toContainText("192.168.10.8:443");
  await page.locator("#modal button[type=submit]").click();
  await expect(page.locator("[data-tunnel-result]")).toHaveAttribute("data-verification", "pending");
  expect(input.proxy_type).toBe("http"); expect(input.local_scheme).toBe("https");
  expect(input.remote_port).toBeUndefined();
  snapshot.diagnostic = { source: "agent", target: "device_local", transport: "https", failure: "tls" };
  await page.locator("[data-verify]").click();
  await expect(page.locator("[data-tunnel-result]")).toHaveAttribute("data-verification", "error");
  await expect(page.locator("[data-tunnel-result]")).toContainText("目标 TLS");
  snapshot.diagnostic.failure = "none";
  await page.locator("[data-verify]").click();
  await expect(page.locator("[data-tunnel-result]")).toHaveAttribute("data-verification", "verified");
  expect(writes).toBe(1);
});

test("raw templates omit client-selected public ports and never submit web credentials", async ({ page }) => {
  await ready(page, "/admin?role=user#connections");
  let input;
  await page.route("**/api/v1/client/connections", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    input = route.request().postDataJSON();
    await route.fulfill({ status: 403, json: { error_code: "CLIENT_RAW_TUNNELS_DISABLED", message: "权限已变更，请重新选择服务。" } });
  });
  await page.locator('[data-action="create-connection"]').click();
  await page.locator("#modal-name").fill("SSH");
  await page.locator("#modal-client-preset").selectOption("ssh");
  await page.locator("#modal button[type=submit]").click();
  await expect(page.locator("#modal-local_port")).toHaveValue("22");
  await page.locator("#modal button[type=submit]").click();
  await expect(page.locator("#modal-http-options")).toBeHidden();
  await expect(page.locator("[data-port-allocation]")).toBeVisible();
  await page.locator("#modal button[type=submit]").click();
  await page.locator("#modal button[type=submit]").click();
  await expect(page.locator("#modal-error")).toContainText("权限");
  expect(input.application_protocol).toBe("ssh"); expect(input.proxy_type).toBe("tcp");
  expect(input.remote_port).toBeUndefined(); expect(input.access).toBeUndefined(); expect(input.subdomain).toBeUndefined();
});

test("English wizard fits a narrow dark layout and retains editable template values", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => { localStorage.setItem("ht_locale", "en"); localStorage.setItem("ht_theme", "dark"); });
  await ready(page);
  await page.locator('[data-action="create-connection"]').click();
  await expect(page.locator("#modal-title")).toHaveText("Publish a service");
  const nameBox = await page.locator("#modal-name").boundingBox();
  const footerBox = await page.locator("#modal-footer").boundingBox();
  expect(nameBox.y + nameBox.height).toBeLessThan(footerBox.y);
  await page.locator("#modal-name").fill("Home Assistant");
  await page.locator("#modal-client-preset").selectOption("home-assistant");
  await page.locator("#modal button[type=submit]").click();
  await expect(page.locator("#modal-local_port")).toHaveValue("8123");
  await page.locator("#modal-local_port").fill("8124");
  await page.locator("#modal-footer").getByRole("button", { name: "Back", exact: true }).click();
  await page.locator("#modal button[type=submit]").click();
  await expect(page.locator("#modal-local_port")).toHaveValue("8124");
  expect(await page.locator("#modal").evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.keyboard.press("Escape");
  await page.locator('[data-action="create-connection"]').click();
  await page.locator("#modal button[type=submit]").click();
  await expect(page.locator("#modal-local_port")).toHaveValue("8124");
});

test("connection edit conflict keeps draft and permits an explicit retry", async ({ page }) => {
  await ready(page);
  await page.locator('[data-action="edit-connection"]').first().click();
  await page.locator("#modal-name").fill("我修改的名称");
  let writes = 0;
  await page.route("**/api/v1/admin/connections/*", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    if (++writes === 1)
      return route.fulfill({
        status: 409,
        json: { error_code: "VERSION_CONFLICT", message: "连接已被其他操作修改" },
      });
    await route.continue();
  });
  await page.locator("#modal button[type=submit]").click();
  await expect(page.locator("#modal-name")).toHaveValue("我修改的名称");
  await page.getByRole("button", { name: "读取最新版本并保留我的修改" }).click();
  await expect(page.locator("#modal-error")).toContainText("已读取最新版本");
  await page.locator("#modal button[type=submit]").click();
  await expect(page.locator("#modal")).not.toBeVisible();
});

for (const width of [375, 768, 1024, 1280, 1440])
  test(`connection layout fits ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await ready(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect(page.locator('[data-action="edit-connection"]').first()).toBeVisible();
  });

test("mobile navigation exposes three business destinations and account administration", async ({page}) => {
    await page.setViewportSize({width:375,height:812});await ready(page);
    for(const view of ["devices","remote","connections","account"]) {
      const button=page.locator(`.nav-item[data-view="${view}"]`);
      await expect(button).toBeVisible();await expect(button).toHaveAccessibleName(/\S/);
      const box=await button.boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(375);
    }
    await page.locator('.user-chip-name[data-view="account"]').click();
    let releaseSettings, settingsRequested;
    const pendingSettings=new Promise(resolve=>{releaseSettings=resolve;});
    const requestedSettings=new Promise(resolve=>{settingsRequested=resolve;});
    await page.route('**/api/v1/admin/settings',async route=>{
      settingsRequested();await pendingSettings;await route.continue();
    });
    await page.locator('.administration-links [data-view="settings"]').click();
    await requestedSettings;
    await expect(page.locator("#page-title")).toHaveText("系统设置");
    const devices=page.locator('[data-view="devices"]');
    await devices.focus();await expect(devices).toBeFocused();
    releaseSettings();await expect(page.locator('#view-content')).toHaveAttribute('aria-busy','false');
    await expect(devices).toBeFocused();await page.keyboard.press("Enter");
    await expect(page.locator("#page-title")).toHaveText("设备管理");
    await expect(page.locator('[data-view="devices"]')).toHaveAttribute("aria-current","page");
    await page.locator('.product-bar [data-locale-toggle]').click();
    await expect(page.locator('[data-view="devices"]')).toHaveAccessibleName("Devices");
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  });
  test("ordinary account never receives administrative navigation and direct routes resolve to devices", async ({page}) => {
    await page.setViewportSize({width:320,height:700});await ready(page,"/admin?role=user#account");
    await expect(page.locator('.administration-links')).toHaveCount(0);
    await expect(page.locator('#version-button')).toBeVisible();
    await page.goto('/admin?role=user#admin-devices');
    await expect(page.locator('#view-content')).toHaveAttribute('aria-busy','false');
    await expect(page.locator('#page-title')).toHaveText('设备管理');
    await page.setViewportSize({width:1440,height:960});
    await expect(page.locator('.nav-item[data-view="account"]')).toBeVisible();
  });

test("browser remote controls translate in both directions", async ({ page }) => {
  await ready(page, "/admin#remote");
  await page.locator(".product-bar [data-locale-toggle]").click();
  await expect(page.locator("#view-content")).toContainText("Connect to a partner device");
  await expect(page.locator("#remote-connect-form button[type=submit]")).toHaveText("Connect");
  await page.locator(".product-bar [data-locale-toggle]").click();
  await expect(page.locator("#remote-connect-form button[type=submit]")).toHaveText("连接");
});

test("realtime startup preserves foreground loading failures and an explicit retry", async ({ page }) => {
  let release, requests = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  await page.route(/\/api\/v1\/admin\/users(?:\?|$)/, async (route) => {
    requests++;
    if (requests > 1) return route.continue();
    await pending;
    return route.fulfill({ status: 503, json: { error_code: "TEMPORARY_UNAVAILABLE", message: "服务暂不可用" } });
  });
  try {
    await page.goto("/admin#users");
    await expect.poll(() => requests).toBe(1);
    await expect(page.locator("#sync-status")).toHaveCount(0);
    await expect(page.locator("#view-content")).toHaveAttribute("aria-busy", "true");
    expect(requests).toBe(1);
    release();
    await expect(page.locator("#view-content")).toContainText("无法加载数据");
    await expect(page.locator("#view-content")).toContainText("重试");
    await page.locator(".product-bar [data-locale-toggle]").click();
    await expect(page.locator("#view-content")).toContainText("Retry");
    await page.locator(".product-bar [data-locale-toggle]").click();
    await expect(page.locator("#view-content .skeleton")).toHaveCount(0);
    await page.locator("#view-content").getByRole("button", { name: "重试", exact: true }).click();
    await expect(page.locator("#view-content")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#view-content")).not.toContainText("无法加载数据");
  } finally { release(); }
});

test("standard user can access account limits and edit raw targets without errors", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/v1/client/connections?**", async (route) => {
    const data = await (await route.fetch()).json();
    data.items[0].proxy_type = "tcp";
    data.items[0].local_port = 22;
    await route.fulfill({ json: data });
  });
  await ready(page, "/admin?role=user#connections");
  await expect(page.locator(".connection-target").first()).toContainText("tcp://");
  await page.locator('[data-action="edit-connection"]').first().click();
  await expect(page.locator("#modal")).toBeVisible();
  expect(errors).toEqual([]);
  await page.keyboard.press("Escape");
  await page.locator('.nav-item[data-view="account"]').click();
  await expect(page.locator("#view-content")).toContainText("月度配额");
});

test("custom domain removal requires confirmation and cancellation sends no write", async ({
  page,
}) => {
  await ready(page);
  await page.locator(".more-actions summary").first().click();
  await page.locator('[data-action="custom-domains"]').first().click();
  await page.locator("#modal-domain").fill("nas.example.net");
  await page.locator("#modal button[type=submit]").click();
  await expect(page.locator("[data-domain-delete]")).toHaveCount(1);
  let deletes = 0;
  await page.route("**/api/v1/admin/custom-domains/*", async (route) => {
    if (route.request().method() === "DELETE") deletes++;
    await route.continue();
  });
  await page.locator("[data-domain-delete]").click();
  await expect(page.locator("[data-domain-delete]")).toHaveText("确认删除这个域名");
  expect(deletes).toBe(0);
  await page.locator("#modal-body").getByRole("button", { name: "取消", exact: true }).click();
  expect(deletes).toBe(0);
  await page.locator("[data-domain-delete]").click();
  await page.locator("[data-domain-delete]").click();
  await expect(page.locator("[data-domain-delete]")).toHaveCount(0);
  expect(deletes).toBe(1);
});

test("server field errors are shown at the input and preserve the form", async ({ page }) => {
  await ready(page, "/admin?role=user#connections");
  await page.locator('[data-action="create-connection"]').click();
  await page.locator("#modal-name").fill("家庭服务");
  await page.route("**/api/v1/client/connections", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({
      status: 400,
      json: {
        error_code: "VALIDATION_ERROR",
        message: "请修改错误字段",
        field_errors: { local_port: "端口无效，请检查目标服务" },
      },
    });
  });
  for (let step = 0; step < 4; step++) await page.locator("#modal button[type=submit]").click();
  await expect(page.locator('[data-step="1"]')).toBeVisible();
  await expect(page.locator("#modal-local_port")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#modal-local_port-error")).toContainText("端口无效");
  await expect(page.locator("#modal-name")).toHaveValue("家庭服务");
});

test("same-named connections have separate drafts and retain only the user's changes", async ({
  page,
  request,
}) => {
  const fixture = await (await request.get("/api/v1/admin/connections")).json();
  fixture.items[1].name = fixture.items[0].name;
  await page.route("**/api/v1/admin/connections?**", (route) => route.fulfill({ json: fixture }));
  await ready(page);
  await page.locator('[data-action="edit-connection"]').first().click();
  await page.locator("#modal-name").fill("我正在修改的连接");
  await page.keyboard.press("Escape");
  await page.locator('[data-action="edit-connection"]').nth(1).click();
  await expect(page.locator("#modal-name")).toHaveValue(fixture.items[1].name);
  await page.keyboard.press("Escape");
  fixture.items[0].local_port = 9001;
  fixture.items[0].version++;
  const refreshed = page.waitForResponse(response => response.url().includes('/api/v1/admin/connections?'));
  await page.locator('.nav-primary[data-view="connections"]').click();
  await refreshed;
  await page.locator('[data-action="edit-connection"]').first().click();
  await expect(page.locator("#modal-name")).toHaveValue("我正在修改的连接");
  await expect(page.locator("#modal-local_port")).toHaveValue("9001");
});

test("nested IP errors reopen advanced settings and focus the relevant field", async ({ page }) => {
  await ready(page, "/admin?role=user#connections");
  await page.locator('[data-action="create-connection"]').click();
  await page.locator("#modal-name").fill("家庭服务");
  await page.locator("#modal button[type=submit]").click();
  await page.locator("#modal button[type=submit]").click();
  await page.locator(".advanced-options summary").click();
  await page.locator("#modal-access_allowlist").fill("invalid-ip");
  await page.locator(".advanced-options summary").click();
  await page.route("**/api/v1/client/connections", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({
      status: 400,
      json: {
        error_code: "VALIDATION_ERROR",
        message: "请检查访问保护",
        field_errors: { "access.ip_allowlist.0": "请输入有效的 IP 或 CIDR" },
      },
    });
  });
  await page.locator("#modal button[type=submit]").click();
  await page.locator("#modal button[type=submit]").click();
  await expect(page.locator("#modal-access_allowlist")).toBeFocused();
  await expect(page.locator("#modal-access_allowlist-error")).toHaveText("请输入有效的 IP 或 CIDR");
});
