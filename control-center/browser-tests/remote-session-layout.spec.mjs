import { test, expect } from "@playwright/test";
import { installSessionUiFixtures, exerciseSessionUi } from "./fixtures/session-ui.mjs";

test.beforeEach(async ({ request }) => { await request.post("/__preview/reset"); });
test.afterEach(async ({ context }) => { await context.unrouteAll({ behavior: "wait" }); });

for (const theme of ["light", "dark"]) for (const width of [390, 1440]) {
  test(`fullscreen ${theme} viewer at ${width}px keeps tools, clipboard and file names separate`, async ({ page, context }) => {
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
    await page.locator("[data-remote-trust]").click();
    const popup = await opening;
    await popup.setViewportSize({ width, height: 844 });
    await exerciseSessionUi(popup, "files");
    await popup.locator("[data-fullscreen]").click();
    await popup.waitForFunction(() => document.fullscreenElement?.classList.contains("remote-viewer"));
    const metrics = await popup.locator(".remote-viewer").evaluate(viewer => {
      const visible = element => getComputedStyle(element).display !== "none" && element.getBoundingClientRect().height > 0;
      const blocks = [...viewer.children].filter(visible).map(element => {
        const rect = element.getBoundingClientRect();
        return { name: element.className, top: rect.top, bottom: rect.bottom };
      }).sort((a, b) => a.top - b.top);
      const toolbars = [...viewer.querySelectorAll(".remote-toolbar")].filter(visible).map(element => ({ height: element.clientHeight, needed: element.scrollHeight }));
      const names = [...viewer.querySelectorAll(".remote-file-row [data-no-translate]")].map(element => ({ width: element.getBoundingClientRect().width, row: element.parentElement.clientWidth }));
      const panel = viewer.querySelector("[data-clipboard-panel]");
      return { blocks, toolbars, names, panelColor: getComputedStyle(panel).color, panelBackground: getComputedStyle(panel).backgroundColor };
    });
    for (let index = 1; index < metrics.blocks.length; index++)
      expect(metrics.blocks[index].top, `${metrics.blocks[index].name} must follow ${metrics.blocks[index - 1].name}`).toBeGreaterThanOrEqual(metrics.blocks[index - 1].bottom - 1);
    for (const bar of metrics.toolbars) expect(bar.needed).toBeLessThanOrEqual(bar.height + 1);
    expect(metrics.names).toHaveLength(3);
    for (const name of metrics.names) expect(name.width).toBeGreaterThanOrEqual(Math.min(name.row, 240) - 1);
    const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
      value /= 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const colors = [luminance(metrics.panelColor), luminance(metrics.panelBackground)].sort((a, b) => b - a);
    expect((colors[0] + 0.05) / (colors[1] + 0.05)).toBeGreaterThanOrEqual(4.5);
    await popup.close();
  });
}
