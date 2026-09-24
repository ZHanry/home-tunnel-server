import { test, expect } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  await request.post("/__preview/reset");
});
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});
async function ready(page) {
  await page.goto("/admin#settings");
  await expect(page.locator("#view-content")).toHaveAttribute("aria-busy", "false");
}

test("administrator saves TCP/UDP policies and sees the persisted settings after refresh", async ({
  page,
}) => {
  await ready(page);
  await expect(page.getByRole("heading", { name: "端口与协议" })).toBeVisible();
  await page.locator("#tcp-port-start").fill("10022");
  await page.locator("#tcp-port-end").fill("10025");
  await page.locator("#udp-enabled").uncheck();
  await page.locator("#client-raw-tunnels").check();
  const write = page.waitForRequest(
    (r) => r.method() === "PATCH" && r.url().endsWith("/admin/settings"),
  );
  await page.getByRole("button", { name: "保存设置" }).click();
  const body = (await write).postDataJSON();
  expect(body.transport_tunnels.tcp).toEqual({ enabled: true, port_start: 10022, port_end: 10025 });
  expect(body.transport_tunnels.udp.enabled).toBe(false);
  expect(body.transport_settings_version).toBe(0);
  expect(body.client_raw_tunnels_enabled).toBe(true);
  await expect(page.locator("#toast-region")).toContainText("部署设置已保存");
  await page.reload();
  await expect(page.locator("#tcp-port-start")).toHaveValue("10022");
  await expect(page.locator("#udp-enabled")).not.toBeChecked();
  await expect(page.locator('[data-transport="udp"] .status-badge')).toHaveText("已关闭");
});

test("unprepared pools explain one-time setup and cannot be enabled by the form", async ({
  page,
}) => {
  let posted;
  await page.route("**/api/v1/admin/settings", async (route) => {
    if (route.request().method() === "PATCH") {
      posted = route.request().postDataJSON();
      return route.continue();
    }
    const data = await (await route.fetch()).json();
    for (const policy of Object.values(data.transport_tunnels)) {
      policy.deployment_ready = false;
      policy.enabled = false;
      policy.configured_enabled = false;
    }
    await route.fulfill({ json: data });
  });
  await ready(page);
  await expect(page.locator("#tcp-enabled")).toBeDisabled();
  await expect(page.locator("#udp-port-start")).toBeDisabled();
  await page.locator(".transport-setup summary").click();
  await expect(page.locator(".transport-setup")).toContainText("compose.ports.yaml");
  await page.locator("#client-raw-tunnels").check();
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.locator("#toast-region")).toContainText("部署设置已保存");
  expect(posted.transport_tunnels).toBeUndefined();
});

test("invalid ranges are blocked locally and occupied-port errors keep edits for correction", async ({
  page,
}) => {
  await ready(page);
  await page.locator("#tcp-port-start").fill("10050");
  await page.locator("#tcp-port-end").fill("10020");
  expect(await page.locator("#tcp-port-end").evaluate((input) => input.checkValidity())).toBe(
    false,
  );
  await page.locator("#tcp-port-end").fill("10100");
  expect(await page.locator("#tcp-port-end").evaluate((input) => input.checkValidity())).toBe(
    false,
  );
  await page.locator("#tcp-port-end").fill("10060");
  await page.route("**/api/v1/admin/settings", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    await route.fulfill({
      status: 409,
      json: {
        error_code: "TRANSPORT_CONNECTIONS_ACTIVE",
        message: "TCP 设置会影响 1 条已启用连接，请先在连接管理中暂停或调整这些连接",
      },
    });
  });
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.locator("#settings-error")).toContainText("暂停或调整这些连接");
  await expect(page.locator("#tcp-port-start")).toHaveValue("10050");
  await expect(page.getByRole("button", { name: "保存设置" })).toBeEnabled();
});

test("port controls fit mobile widths and translate with the rest of the console", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  await expect(page.locator("#tcp-port-start")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.locator(".mobile-preferences [data-locale-toggle]").click();
  await expect(page.getByRole("heading", { name: "Ports and protocols" })).toBeVisible();
  await expect(page.getByLabel("Enable TCP connections")).toBeVisible();
  await page.locator(".mobile-preferences [data-theme-toggle]").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});
