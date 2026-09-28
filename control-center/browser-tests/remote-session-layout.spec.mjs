import { test, expect } from "@playwright/test";
import { installSessionUiFixtures, exerciseSessionUi } from "./fixtures/session-ui.mjs";

test.beforeEach(async ({ request }) => { await request.post("/__preview/reset"); });
test.afterEach(async ({ context }) => { await context.unrouteAll({ behavior: "wait" }); });

for (const theme of ["light", "dark"]) for (const width of [390, 1440]) {
  test(`fullscreen ${theme} viewer at ${width}px fills the window with a floating toolbar and readable drawers`, async ({ page, context }) => {
    await context.addInitScript(theme => {
      if (location.protocol !== "http:") return;
      localStorage.setItem("ht_locale", "en"); localStorage.setItem("ht_theme", theme);
    }, theme);
    await context.route("**/api/v1/public/capabilities", route => route.fulfill({ json: { remote_desktop: { enabled: true, stun_urls: [] } } }));
    await context.route("**/api/v1/rd/endpoints?**", route => route.fulfill({ json: { items: [{
      id: "10000000-0000-4000-8000-000000000001", name: "Review host", owner_user_id: "review-owner", jkt: "review-host-jkt", role: "host", platform: "Windows", status: "active", online: true, local_enabled: true,
      capabilities: { status: "ready", unattended_enabled: true,
        permissions: ["view", "input.keyboard", "input.pointer", "input.text", "clipboard.read", "clipboard.write", "files.send", "files.receive", "audio.system"],
        displays: [{ id: "main", name: "Review display", width: 1280, height: 720 }] },
    }] } }));
    await installSessionUiFixtures(context, { state: "files" });
    await page.goto("/admin#remote");
    const opening = context.waitForEvent("page");
    await page.locator("[data-remote-host]").click();
    const popup = await opening;
    await popup.setViewportSize({ width, height: 844 });
    await exerciseSessionUi(popup, "files");
    await popup.locator("[data-fullscreen]").click();
    await popup.waitForFunction(() => document.fullscreenElement?.classList.contains("remote-viewer"));
    const metrics = await popup.locator(".remote-viewer").evaluate(viewer => {
      const visible = element => getComputedStyle(element).display !== "none" && element.getBoundingClientRect().height > 0;
      const box = element => { const rect = element.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }; };
      // The collapse handle hangs below the floating bar by design; the tool strip itself must not clip.
      const toolbars = [...viewer.querySelectorAll(".remote-tools")].filter(visible).map(element => ({ height: element.clientHeight, needed: element.scrollHeight, width: element.clientWidth, neededWidth: element.scrollWidth }));
      const names = [...viewer.querySelectorAll(".remote-file-row [data-no-translate]")].map(element => ({ width: element.getBoundingClientRect().width, row: element.parentElement.clientWidth }));
      const panel = viewer.querySelector("[data-clipboard-panel]"), drawer = viewer.querySelector(".remote-data");
      return { viewer: box(viewer), stage: box(viewer.querySelector(".remote-video-stage")), drawer: box(drawer),
        drawerOverflow: drawer.scrollWidth - drawer.clientWidth, viewerOverflow: [viewer.scrollWidth - viewer.clientWidth, viewer.scrollHeight - viewer.clientHeight],
        toolbars, names, panelColor: getComputedStyle(panel).color, panelBackground: getComputedStyle(panel).backgroundColor };
    });
    // The remote screen fills the whole fullscreen surface; the toolbar and drawers float over it.
    expect(Math.abs(metrics.stage.top - metrics.viewer.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics.stage.bottom - metrics.viewer.bottom)).toBeLessThanOrEqual(1);
    expect(metrics.viewerOverflow).toEqual([0, 0]);
    expect(metrics.drawer.left).toBeGreaterThanOrEqual(metrics.viewer.left);
    expect(metrics.drawer.right).toBeLessThanOrEqual(metrics.viewer.right + 1);
    expect(metrics.drawer.bottom).toBeLessThanOrEqual(metrics.viewer.bottom + 1);
    expect(metrics.drawerOverflow).toBeLessThanOrEqual(0);
    expect(metrics.toolbars).toHaveLength(1);
    for (const bar of metrics.toolbars) { expect(bar.needed).toBeLessThanOrEqual(bar.height + 1); expect(bar.neededWidth).toBeLessThanOrEqual(bar.width + 1); }
    expect(metrics.names).toHaveLength(3);
    for (const name of metrics.names) expect(name.width).toBeGreaterThanOrEqual(Math.min(name.row, 240) - 1);
    // After the entry peek, the floating toolbar collapses to a handle and reappears on hover.
    const toolbar = popup.locator(".remote-viewer > .remote-toolbar");
    await expect.poll(() => toolbar.evaluate(bar => bar.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
    await popup.evaluate(() => { document.activeElement?.blur(); delete document.querySelector(".remote-viewer").dataset.peek; });
    await popup.mouse.move(width / 2, 700);
    await expect.poll(() => toolbar.evaluate(bar => bar.getBoundingClientRect().bottom)).toBeLessThanOrEqual(8);
    await popup.mouse.move(width / 2, 2);
    await expect.poll(() => toolbar.evaluate(bar => bar.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
    const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
      value /= 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const colors = [luminance(metrics.panelColor), luminance(metrics.panelBackground)].sort((a, b) => b - a);
    expect((colors[0] + 0.05) / (colors[1] + 0.05)).toBeGreaterThanOrEqual(4.5);
    await popup.close();
  });
}
