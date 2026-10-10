import { test, expect } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  await request.post("/__preview/reset");
});
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

const ready = async (page, path = "/admin#devices") => {
  await page.goto(path);
  await expect(page.locator("#app-shell")).toBeVisible();
  await expect(page.locator("#view-content")).toHaveAttribute("aria-busy", "false");
};

const hosts = Array.from({ length: 6 }, (_, index) => ({
  id: `10000000-0000-4000-8000-00000000000${index}`, name: `Host ${index + 1}`, role: "host",
  platform: "windows", status: "active", online: true, local_enabled: true,
  capabilities: { status: "ready", permissions: ["view"], displays: [{ id: "display-1", name: "Main", width: 1920, height: 1080 }] },
}));
const mockRemote = async (page) => {
  await page.route("**/api/v1/public/capabilities", (route) => route.fulfill({ json: { remote_desktop: { enabled: true, stun_urls: [] } } }));
  await page.route("**/api/v1/rd/endpoints?**", (route) => route.fulfill({ json: { items: hosts } }));
};

const luminance = (color) => color.match(/[\d.]+/g).slice(0, 3).map(Number).map((value) => {
  value /= 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
const contrast = (a, b) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
};

test("top preferences match the desktop icons and toggle light and dark", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await ready(page);
  await expect(page.locator(".sidebar select")).toHaveCount(0);
  const toolbar = page.locator(".product-tools");
  const buttons = toolbar.locator("button");
  await expect(buttons).toHaveCount(3);
  const style = await toolbar.evaluate((element) => {
    const box = getComputedStyle(element);
    return { border: box.borderTopStyle, radius: parseFloat(box.borderTopLeftRadius), justify: box.justifyContent,
      buttons: [...element.querySelectorAll("button")].map((button) => {
        const rect = button.getBoundingClientRect(), css = getComputedStyle(button);
        return { width: rect.width, height: rect.height, background: getComputedStyle(element.parentElement).backgroundColor, color: css.color, radius: css.borderTopLeftRadius };
      }) };
  });
  for (const button of style.buttons) {
    expect(button.width).toBeGreaterThanOrEqual(32);
    expect(button.height).toBeGreaterThanOrEqual(32);
    expect(contrast(button.color, button.background)).toBeGreaterThanOrEqual(4.5);
  }
  expect(style.buttons[0].background).toBe(style.buttons[1].background);
  expect(style.buttons[0].radius).toBe(style.buttons[1].radius);

  const toggle = page.locator(".product-bar [data-theme-toggle]");
  await expect(toggle.locator(".theme-icon-moon")).toBeVisible();
  await expect(toggle.locator(".theme-icon-sun")).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(toggle.locator(".theme-icon-sun")).toBeVisible();
  await expect(toggle.locator(".theme-icon-moon")).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => localStorage.getItem("ht_theme"))).toBe("dark");
  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => localStorage.getItem("ht_theme"))).toBe("light");
});

test("the sidebar account entry leads to sign-out with confirmation", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  let signOutRequests = 0;
  page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v2/auth/logout") signOutRequests++; });
  await ready(page);
  const card = page.locator(".sidebar .user-chip");
  await card.locator('[data-view="account"]').click();
  const logout = page.locator('[data-action="logout"]');
  await expect(logout).toBeVisible();
  await expect(logout).toHaveAccessibleName("退出登录");
  await expect(page.locator(".sidebar-footer > #logout-button")).toHaveCount(0);
  await logout.click();
  await expect(page.locator("#modal[open]")).toBeVisible();
  expect(signOutRequests).toBe(0);
  await page.locator("[data-modal-cancel]").click();
  await expect(page.locator("#app-shell")).toBeVisible();
  await logout.click();
  await page.locator('#modal button[type="submit"]').click();
  await expect(page.locator("#auth-screen")).toBeVisible();
  expect(signOutRequests).toBe(1);
});

test("the view container gets no outline when focused on navigation, but controls keep focus-visible", async ({ page }) => {
  await ready(page);
  const nav = page.locator('.nav-item[data-view="devices"]');
  await nav.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#view-content")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#main-content")).toBeFocused();
  expect(await page.locator("#main-content").evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("none");
  await page.keyboard.press("Tab");
  const outline = await page.evaluate(() => {
    const element = document.activeElement;
    return { focusVisible: element.matches(":focus-visible"), style: getComputedStyle(element).outlineStyle, tag: element.tagName };
  });
  expect(outline.focusVisible).toBe(true);
  expect(outline.style).not.toBe("none");
});

for (const theme of ["light", "dark"]) {
  test(`${theme} mode sidebar uses a ${theme} surface with readable navigation`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await ready(page);
    const colors = await page.evaluate(() => {
      const css = (selector) => getComputedStyle(document.querySelector(selector));
      return { side: css(".sidebar").backgroundColor, item: css(".nav-item:not(.active)").color,
        active: css(".nav-item.active").backgroundColor, activeText: css(".nav-item.active").color,
        name: css("#current-user").color, chip: css(".sidebar").backgroundColor };
    });
    expect(colors.side).toBe(theme === "light" ? "rgb(242, 239, 249)" : "rgb(33, 27, 45)");
    expect(contrast(colors.item, colors.side)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.activeText, colors.active)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.name, colors.chip)).toBeGreaterThanOrEqual(4.5);
    expect(colors.active).not.toBe(colors.side);
  });
}

test("main pages have no horizontal overflow at 390px and 2000px in both themes", async ({ page }) => {
  test.setTimeout(120_000);
  await mockRemote(page);
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of [390, 2000]) {
      await page.setViewportSize({ width, height: 900 });
      for (const view of ["dashboard", "remote", "devices", "connections", "users", "audit", "settings", "account"]) {
        await ready(page, `/admin#${view}`);
        const overflow = await page.evaluate(() => {
          const limit = document.documentElement.clientWidth + 1;
          return {
            // scrollbar-gutter keeps a reserved gutter, so scrollWidth can be smaller than clientWidth.
            scroll: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
            elements: [...document.querySelectorAll("#app-shell *")]
              .filter((element) => { const rect = element.getBoundingClientRect(); return rect.width && rect.right > limit; })
              .slice(0, 3).map((element) => `${element.tagName}.${element.className}`),
          };
        });
        expect(overflow, `${theme} ${width}px #${view}`).toEqual({ scroll: 0, elements: [] });
      }
    }
  }
});

test("the browser remote directory fits wide and phone layouts", async ({ page }) => {
  for (const width of [2000, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await ready(page, "/admin#remote");
    const launch = page.locator("#remote-connect-form button[type=submit]");
    await expect(launch).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    expect(overflow).toBe(false);
    const css = await launch.evaluate(button => ({ color: getComputedStyle(button).color,
      background: getComputedStyle(button).backgroundColor, height: button.getBoundingClientRect().height }));
    expect(contrast(css.color, css.background)).toBeGreaterThanOrEqual(4.5);
    expect(css.height).toBeGreaterThanOrEqual(40);
  }
});

test("the browser directory provides optional host verification after account login", async ({ page }) => {
  await ready(page, "/admin#remote");
  await expect(page.locator("#remote-password")).toHaveAttribute("type", "password");
  await expect(page.locator(".remote-assist-preview")).toHaveCount(0);
  await expect(page.locator("#remote-connect-form button[type=submit]")).toBeVisible();
});

for (const width of [1280, 390]) {
  test(`connection rows are compact with inline selection and one action line at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await ready(page, "/admin#connections");
    const row = page.locator(".connection-row").first();
    const box = await row.evaluate((element) => {
      const rect = (selector) => element.querySelector(selector).getBoundingClientRect();
      const actions = [...element.querySelectorAll(".connection-actions > .button, .connection-actions > details > summary")].map((item) => item.getBoundingClientRect());
      return { checkbox: rect("[data-select-connection]"), title: rect("h3"), meta: rect(".connection-meta"), address: rect(".public-address"),
        copy: rect(".public-address [data-copy]"), actions, container: rect(".connection-actions"), row: element.getBoundingClientRect(),
        accent: getComputedStyle(element.querySelector("[data-select-connection]")).accentColor };
    });
    // Checkbox sits on the title line, and meta sits below the title.
    expect(Math.abs((box.checkbox.top + box.checkbox.bottom) / 2 - (box.title.top + box.title.bottom) / 2)).toBeLessThanOrEqual(12);
    expect(box.checkbox.right).toBeLessThanOrEqual(box.title.left);
    expect(box.meta.top).toBeGreaterThanOrEqual(box.title.bottom - 1);
    expect(box.copy.right).toBeLessThanOrEqual(box.address.right + 1);
    expect(box.accent).not.toBe("auto");
    expect(box.actions).toHaveLength(4);
    const tops = new Set(box.actions.map((action) => Math.round(action.top)));
    expect(tops.size, "actions share one line").toBe(1);
    const heights = new Set(box.actions.map((action) => Math.round(action.height)));
    expect(heights.size, "actions share one height").toBe(1);
    if (width >= 1280) {
      expect(box.row.height).toBeLessThanOrEqual(150);
      expect(box.actions.at(-1).right).toBeGreaterThanOrEqual(box.row.right - 40 - 1);
      const batch = await page.locator('[data-action="batch-connections"]').first().boundingBox();
      expect(batch.height).toBeLessThanOrEqual(40);
    } else {
      for (const action of box.actions) expect(action.height).toBeGreaterThanOrEqual(44);
      expect((await page.locator('[data-action="batch-connections"]').first().boundingBox()).height).toBeGreaterThanOrEqual(44);
      expect((await page.locator(".connection-select").first().boundingBox()).height).toBeGreaterThanOrEqual(44);
    }
    await expect(row.locator("[data-select-connection]")).toHaveAccessibleName("选择此连接");
    await row.locator(".connection-select").click();
    await expect(row.locator("[data-select-connection]")).toBeChecked();
    await row.locator(".more-actions summary").click();
    const menu = row.locator(".more-actions > div");
    await expect(menu.locator('[data-action="delete-connection"]')).toBeVisible();
    const menuBox = await menu.boundingBox();
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width);
  });
}
