import { test, expect } from "@playwright/test";
import { installSessionUiFixtures, exerciseSessionUi } from "./fixtures/session-ui.mjs";

// The desktop client opens the viewer in its own window; these checks cover that popout layout.
const host = {
  id: "10000000-0000-4000-8000-000000000001", name: "Review host", owner_user_id: "review-owner", jkt: "review-host-jkt",
  role: "host", platform: "Windows", status: "active", online: true, local_enabled: true,
  capabilities: { status: "ready", permissions: ["view", "input.keyboard", "input.pointer", "input.text", "clipboard.read", "clipboard.write", "files.send", "files.receive", "audio.system"],
    displays: [{ id: "main", name: "Review display", width: 1280, height: 720 }] },
};

test.beforeEach(async ({ request }) => { await request.post("/__preview/reset"); });
test.afterEach(async ({ context }) => { await context.unrouteAll({ behavior: "wait" }); });

async function openViewer(page, context, { locale = "zh-CN", theme = "light", viewport = { width: 1280, height: 840 }, connect = true } = {}) {
  await context.addInitScript(({ locale, theme }) => {
    if (location.protocol !== "http:") return;
    localStorage.setItem("ht_locale", locale); localStorage.setItem("ht_theme", theme);
  }, { locale, theme });
  await context.route("**/api/v1/public/capabilities", route => route.fulfill({ json: { remote_desktop: { enabled: true, stun_urls: [] } } }));
  await context.route("**/api/v1/rd/endpoints?**", route => route.fulfill({ json: { items: [host] } }));
  await installSessionUiFixtures(context, { state: "viewing" });
  await page.goto("/admin#remote");
  const opening = context.waitForEvent("page");
  await page.locator("[data-remote-host]").click();
  const popup = await opening;
  await popup.setViewportSize(viewport);
  await expect(popup.locator(".remote-auth")).toBeVisible();
  if (connect) {
    await exerciseSessionUi(popup, "viewing");
    await expect(popup.locator(".remote-viewer")).toBeVisible();
  }
  return popup;
}

// Horizontal/vertical overflow of every scroll container that makes up the viewer window.
const overflow = (popup) => popup.evaluate(() => {
  const nodes = [document.documentElement, ...document.querySelectorAll(".remote-dialog, .remote-viewer, .remote-toolbar, .remote-tools, .remote-video-stage, .remote-card")];
  return nodes.filter(node => node.getBoundingClientRect().height > 0).map(node => ({ node: node.className || node.tagName,
    x: node.scrollWidth - node.clientWidth, y: node.scrollHeight - node.clientHeight }))
    .filter(entry => entry.x > 0 || (entry.y > 0 && !entry.node.includes("remote-tools")));
});

test("the popout viewer has no close-window button or how-to block, before or after connecting", async ({ page, context }) => {
  const popup = await openViewer(page, context, { connect: false });
  const dialog = popup.locator(".remote-dialog");
  const text = () => dialog.evaluate(element => element.textContent + [...element.querySelectorAll("[aria-label],[title]")].map(node => node.getAttribute("aria-label") + node.title).join(" "));
  await expect(dialog.locator("[data-close]")).toHaveCount(0);
  await expect(dialog.locator("[data-cancel]")).toBeVisible();
  for (const phrase of ["关闭窗口", "使用说明"]) expect(await text()).not.toContain(phrase);
  await expect(dialog.locator("details")).toHaveCount(0);
  await exerciseSessionUi(popup, "viewing");
  await expect(dialog.locator(".remote-viewer")).toBeVisible();
  await expect(dialog.locator(".remote-card")).toBeHidden();
  for (const phrase of ["关闭窗口", "使用说明"]) expect(await text()).not.toContain(phrase);
  // The host name and status now live in the slim top bar next to a quiet disconnect button with a red icon (solid red on hover).
  await expect(dialog.locator(".remote-toolbar h2")).toHaveText(host.name);
  await expect(dialog.locator(".remote-toolbar .remote-status")).toHaveText(/已连接/);
  await expect(dialog).toHaveAttribute("data-live", "true");
  await expect(dialog.locator("[data-disconnect]")).toHaveText("断开");
  const disconnect = await dialog.locator("[data-disconnect]").evaluate(button => getComputedStyle(button.querySelector("svg")).color);
  const [red, green, blue] = disconnect.match(/\d+/g).map(Number);
  expect(red).toBeGreaterThan(green + 80); expect(red).toBeGreaterThan(blue + 80);
  await popup.close();
});

for (const locale of ["zh-CN", "en"]) {
  test(`toolbar icon buttons expose ${locale} accessible names and tooltips`, async ({ page, context }) => {
    const popup = await openViewer(page, context, { locale });
    const dialog = popup.locator(".remote-dialog");
    await expect(dialog).toHaveAttribute("aria-labelledby", /remote-title-/);
    const labelledBy = await dialog.getAttribute("aria-labelledby");
    await expect(popup.locator(`#${labelledBy}`)).toHaveText(host.name);
    const tools = await dialog.locator(".remote-tool").evaluateAll(buttons => buttons.map(button => ({
      hook: [...button.attributes].map(attribute => attribute.name).find(name => name.startsWith("data-")),
      label: button.getAttribute("aria-label"), title: button.title, text: button.querySelector("span").textContent,
      icons: button.querySelectorAll("svg[aria-hidden=true]").length, hidden: button.hidden })));
    expect(tools.map(tool => tool.hook)).toEqual(["data-input", "data-release", "data-fullscreen", "data-clipboard", "data-files", "data-text-toggle", "data-audio", "data-microphone", "data-play", "data-diagnostics-toggle"]);
    for (const tool of tools) {
      expect(tool.label, tool.hook).toBeTruthy();
      expect(tool.label).toBe(tool.text);
      expect(tool.title).toBe(tool.label);
      expect(tool.icons).toBe(1);
      if (locale === "en") expect(tool.label).not.toMatch(/\p{Script=Han}/u);
    }
    // The host does not offer microphone forwarding, so that tool stays out of the bar.
    expect(tools.find(tool => tool.hook === "data-microphone").hidden).toBe(true);
    await expect(dialog.getByRole("button", { name: locale === "en" ? "Full screen" : "全屏" })).toBeVisible();
    // Every visible control has an accessible name.
    const unnamed = await dialog.locator("button:visible, select:visible, textarea:visible, input:visible").evaluateAll(controls => controls
      .filter(control => !(control.getAttribute("aria-label") || control.labels?.[0]?.textContent.trim() || control.textContent.trim())).map(control => control.outerHTML.slice(0, 80)));
    expect(unnamed).toEqual([]);
    // Labels that change with state keep the accessible name in sync (and translated).
    await dialog.locator("[data-audio]").click();
    await expect(dialog.locator("[data-audio]")).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.locator("[data-audio]")).toHaveAttribute("aria-label", locale === "en" ? "Disable system audio" : "关闭系统声音");
    await popup.close();
  });
}

for (const viewport of [{ width: 1280, height: 840 }, { width: 960, height: 640 }]) {
  for (const theme of ["light", "dark"]) {
    test(`connected ${theme} viewer fills a ${viewport.width}x${viewport.height} window without overflow or scrollbars`, async ({ page, context }) => {
      const popup = await openViewer(page, context, { theme, viewport });
      await expect(popup.locator("html")).toHaveAttribute("data-theme", theme);
      const layout = await popup.locator(".remote-dialog").evaluate(dialog => {
        const rect = element => element.getBoundingClientRect();
        const toolbar = rect(dialog.querySelector(".remote-toolbar")), stage = rect(dialog.querySelector(".remote-video-stage"));
        const visibleTools = [...dialog.querySelectorAll(".remote-toolbar button, .remote-display-picker")].filter(element => element.getClientRects().length).map(rect);
        const video = dialog.querySelector("video");
        return { dialog: rect(dialog), toolbar, stage, visibleTools, innerWidth, innerHeight,
          toolbarHeight: toolbar.height, videoFit: getComputedStyle(video).objectFit,
          stageBackground: getComputedStyle(dialog.querySelector(".remote-video-stage")).backgroundColor,
          viewerScrollbar: getComputedStyle(dialog.querySelector(".remote-viewer")).scrollbarWidth };
      });
      expect(layout.dialog.width).toBe(layout.innerWidth);
      expect(layout.dialog.height).toBe(layout.innerHeight);
      expect(layout.toolbarHeight).toBeLessThanOrEqual(60);
      expect(layout.stage.top).toBeGreaterThanOrEqual(layout.toolbar.bottom - 1);
      expect(Math.abs(layout.stage.bottom - layout.innerHeight)).toBeLessThanOrEqual(1);
      expect(layout.stage.width).toBe(layout.innerWidth);
      for (const box of layout.visibleTools) {
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(layout.innerWidth);
        expect(box.top).toBeGreaterThanOrEqual(layout.toolbar.top);
        expect(box.bottom).toBeLessThanOrEqual(layout.toolbar.bottom);
      }
      expect(layout.videoFit).toBe("contain");
      // The remote screen is letterboxed on black regardless of the console theme.
      expect(layout.stageBackground.match(/\d+/g).slice(0, 3).map(Number).every(channel => channel < 20)).toBe(true);
      expect(layout.viewerScrollbar).toBe("none");
      expect(await overflow(popup)).toEqual([]);
      await popup.close();
    });
  }
  test(`pre-connection card is centered at ${viewport.width}x${viewport.height} without overflow`, async ({ page, context }) => {
    const popup = await openViewer(page, context, { viewport, connect: false, theme: "dark" });
    const card = await popup.locator(".remote-card").evaluate(element => { const box = element.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, innerWidth, innerHeight }; });
    expect(Math.abs(card.left - (card.innerWidth - card.right))).toBeLessThanOrEqual(1);
    expect(card.top).toBeGreaterThanOrEqual(0);
    expect(card.bottom).toBeLessThanOrEqual(card.innerHeight);
    expect(await overflow(popup)).toEqual([]);
    await popup.close();
  });
}

test("keyboard focus is visible on tools while pointer clicks leave no outline, and reduced motion stops spinners", async ({ page, context }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const popup = await openViewer(page, context, { connect: false });
  await popup.emulateMedia({ reducedMotion: "reduce" });
  expect(await popup.locator(".remote-card .remote-status").evaluate(status => getComputedStyle(status, "::before").animationName)).toBe("none");
  await exerciseSessionUi(popup, "viewing");
  const fullscreen = popup.locator("[data-fullscreen]");
  await popup.locator("[data-files]").click();
  expect(await popup.locator("[data-files]").evaluate(button => getComputedStyle(button).outlineStyle)).toBe("none");
  await fullscreen.evaluate(button => button.previousElementSibling.querySelector("select").focus());
  await popup.keyboard.press("Tab");
  await expect(fullscreen).toBeFocused();
  expect(await fullscreen.evaluate(button => getComputedStyle(button).outlineStyle)).toBe("solid");
  await popup.close();
});

test("the file drawer opens as a compact popover over the screen and disconnect ends the session", async ({ page, context }) => {
  const popup = await openViewer(page, context, { viewport: { width: 960, height: 640 } });
  await popup.locator("[data-files]").click();
  await expect(popup.locator("[data-file-panel]")).toBeVisible();
  const drawer = await popup.locator(".remote-data").evaluate(element => { const box = element.getBoundingClientRect(), stage = element.parentElement.getBoundingClientRect(); return { width: box.width, right: box.right, top: box.top, stageRight: stage.right, stageTop: stage.top }; });
  expect(drawer.width).toBeLessThanOrEqual(360);
  expect(drawer.top).toBeGreaterThanOrEqual(drawer.stageTop);
  expect(drawer.right).toBeLessThanOrEqual(drawer.stageRight);
  await popup.locator("[data-text-toggle]").click();
  await expect(popup.locator("[data-text-toggle]")).toHaveAttribute("aria-expanded", "true");
  await expect(popup.locator(".remote-text textarea")).toBeFocused();
  await popup.locator("[data-disconnect]").click();
  await expect.poll(() => popup.isClosed()).toBe(true);
});
