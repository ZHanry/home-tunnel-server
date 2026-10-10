// NestLink的几何验收：真实预览数据，所有指定尺寸均保存原始全页截图。
import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const artifactRoot = resolve("../outputs/nestlink-web-14");
const views = [
  "dashboard",
  "remote",
  "devices",
  "admin-devices",
  "connections",
  "users",
  "audit",
  "settings",
  "account",
];

async function geometry(page, scope = "#app-shell") {
  return page.locator(scope).evaluate((root) => {
    const failures = [];
    let assertions = 0;
    const visible = (element) =>
      element.getClientRects().length && getComputedStyle(element).visibility !== "hidden";
    const check = (condition, label) => {
      assertions++;
      if (!condition) failures.push(label);
    };
    const box = (element) => element.getBoundingClientRect();
    const tolerance = 1;
    check(
      document.documentElement.scrollWidth <= document.documentElement.clientWidth + tolerance,
      "document horizontal overflow",
    );
    for (const element of root.querySelectorAll("*")) {
      if (!visible(element) || element.closest(".visually-hidden,details:not([open]) > :not(summary)"))
        continue;
      const rect = box(element);
      if (!rect.width || !rect.height) continue;
      check(
        rect.left >= -tolerance && rect.right <= document.documentElement.clientWidth + tolerance,
        `viewport boundary: ${element.tagName}.${element.className}`,
      );
      const css = getComputedStyle(element);
      if (
        !element.children.length &&
        element.textContent.trim() &&
        !element.matches("input,textarea,select,svg,path,button")
      ) {
        check(
          !["hidden", "clip"].includes(css.overflowX) ||
            element.scrollWidth <= element.clientWidth + tolerance,
          `clipped text: ${element.tagName}.${element.className}`,
        );
      }
    }
    // 逐行测量文字；裁切或相邻文字重叠时必须失败。
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const lines = [];
    let node;
    while ((node = walker.nextNode())) {
      if (
        !node.textContent.trim() ||
        !visible(node.parentElement) ||
        node.parentElement.closest(
          "svg,script,style,.visually-hidden,input,textarea,select,details:not([open]) > :not(summary)",
        )
      )
        continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const parent = box(node.parentElement);
      for (const rect of range.getClientRects()) {
        if (!rect.width || !rect.height) continue;
        // 手机底部导航是不透明的固定层；被它遮住的滚动内容不是可见文字。
        const y = (rect.top + rect.bottom) / 2;
        if (y >= 0 && y < innerHeight && !node.parentElement.closest(".sidebar")) {
          const hit = document.elementFromPoint((rect.left + rect.right) / 2, y);
          if (hit?.closest(".sidebar")) continue;
        }
        check(
          rect.left >= parent.left - tolerance && rect.right <= parent.right + tolerance,
          `text boundary: ${node.textContent.trim().slice(0, 36)}`,
        );
        lines.push({ rect, node });
      }
    }
    for (let i = 0; i < lines.length; i++)
      for (let j = i + 1; j < lines.length; j++) {
        const a = lines[i],
          b = lines[j];
        if (a.node === b.node) continue;
        const vertical = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
        if (vertical <= Math.min(a.rect.height, b.rect.height) * 0.65) continue;
        const horizontal =
          Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
        check(
          horizontal <= tolerance,
          `text overlap: ${a.node.textContent.trim().slice(0, 20)} / ${b.node.textContent.trim().slice(0, 20)}`,
        );
      }
    const content = root.querySelector("#view-content");
    const title = root.querySelector("#page-title");
    const header = root.querySelector("#topbar");
    if (content && title && header && visible(content)) {
      const base = box(content);
      check(Math.abs(box(header).left - base.left) <= tolerance, "page header left alignment");
      check(Math.abs(box(header).right - base.right) <= tolerance, "page header right alignment");
      check(Math.abs(box(title).left - base.left) <= tolerance, "page title left alignment");
      for (const section of content.children) {
        if (!visible(section)) continue;
        check(
          Math.abs(box(section).left - base.left) <= tolerance,
          `section left alignment: ${section.className}`,
        );
        check(
          Math.abs(box(section).right - base.right) <= tolerance,
          `section right alignment: ${section.className}`,
        );
      }
    }
    for (const table of root.querySelectorAll(".connection-table")) {
      const headings = [...table.querySelectorAll(".connection-table-header [data-column]")];
      if (!headings.length || !visible(headings[0])) continue;
      for (const row of table.querySelectorAll(".connection-row")) {
        for (const heading of headings) {
          const cell = row.querySelector(`[data-column="${heading.dataset.column}"]`);
          check(
            !!cell && Math.abs(box(cell).left - box(heading).left) <= tolerance,
            `connection column alignment: ${heading.dataset.column}`,
          );
        }
      }
    }
    for (const table of root.querySelectorAll(".data-table")) {
      const headings = [...table.querySelectorAll("thead th")];
      if (!headings.length || !visible(headings[0])) continue;
      for (const row of table.querySelectorAll("tbody tr")) {
        const cells = [...row.querySelectorAll(":scope > td")];
        for (let i = 0; i < cells.length; i++) {
          check(
            Math.abs(box(cells[i]).left - box(headings[i]).left) <= tolerance,
            `table column alignment: ${i}`,
          );
        }
      }
    }
    const actionGroups = root.querySelectorAll(
      ".topbar-actions,.connection-actions,.modal-footer,.pagination > div,.sidebar-toolbar",
    );
    for (const group of actionGroups) {
      const controls = [
        ...group.querySelectorAll(":scope > button,:scope > a.button,:scope > details > summary"),
      ].filter(visible);
      for (let i = 1; i < controls.length; i++) {
        const a = box(controls[i - 1]),
          b = box(controls[i]);
        if (Math.abs(a.top - b.top) <= tolerance) {
          check(Math.abs(a.height - b.height) <= tolerance, `control heights: ${group.className}`);
          check(a.right <= b.left + tolerance, `control overlap: ${group.className}`);
        }
      }
    }
    return { assertions, failures };
  });
}

// 弹窗用真实组件打开；安全功能仅使用测试响应，不登记设备或修改真实账号。
for (const theme of ["light", "dark"]) {
  for (const width of [1920, 390]) {
    test(`NestLink dialogs ${theme} ${width}px`, async ({ page, request }) => {
      test.setTimeout(120_000);
      const output = resolve(artifactRoot, "dialogs", `${theme}-${width}`);
      await mkdir(output, { recursive: true });
      await request.post("/__preview/reset");
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript((value) => {
        localStorage.setItem("ht_theme", value);
        localStorage.setItem("ht_locale", "zh");
      }, theme);
      const results = [];
      const ready = async (view) => {
        await page.goto(`/admin#${view}`);
        await expect(page.locator("#view-content")).toHaveAttribute("aria-busy", "false");
      };
      const capture = async (view, scope = "#modal") => {
        await expect(page.locator(scope)).toBeVisible();
        await page.locator(scope).screenshot({ path: resolve(output, `${view}.png`), animations: "disabled" });
        results.push({ view, ...await geometry(page, scope) });
      };
      const close = async () => {
        await page.locator("#modal [data-modal-cancel]").click();
        await expect(page.locator("#modal")).not.toBeVisible();
      };
      const action = async (value) => page.locator(`[data-action="${value}"]`).first().click();
      await ready("connections");
      await page.screenshot({ path: resolve(output, "connections-viewport.png"), animations: "disabled" });
      await action("create-connection");
      await page.locator("#modal-name").fill("家庭测试服务");
      for (let step = 2; step <= 4; step++) {
        await page.locator('#modal button[type="submit"]').click();
        await capture(`wizard-step-${step}`);
      }
      await close();
      for (const value of ["connection-details", "edit-connection"]) {
        await action(value);
        await capture(value);
        if (value === "edit-connection") {
          await page.locator("#modal-body").evaluate((node) => { node.scrollTop = node.scrollHeight; });
          await capture(`${value}-bottom`);
        }
        await close();
      }
      await page.locator(".connection-row .more-actions summary").first().click();
      await action("custom-domains");
      await capture("custom-domains");
      await close();
      await action("delete-connection");
      await capture("delete-connection");
      await close();
      await page.locator("[data-select-connection]").first().check();
      await action("batch-connections");
      await capture("batch-connections");
      await close();
      await ready("admin-devices");
      await action("device-info"); await capture("device-info");
      await action("device-metadata"); await capture("device-metadata"); await close();
      await action("device-info"); await action("purge-physical-device"); await capture("purge-physical-device"); await close();
      await ready("users");
      for (const value of ["create-user", "user-policy"]) {
        await action(value); await capture(value); await close();
      }
      for (const value of ["reset-password", "toggle-user", "delete-user"]) {
        const menu = page.locator(".person-row .more-actions").first();
        if (!await menu.evaluate((node) => node.open)) await menu.locator("summary").click();
        await action(value); await capture(value); await close();
      }
      await ready("account");
      await action("change-password"); await capture("change-password"); await close();
      await expect(page.locator('[data-security]')).toHaveCount(0);
      await page.locator('#version-button').click();
      await capture('version-update'); await close();
      await action("logout"); await capture("logout"); await close();
      await ready("users");
      await action("create-user");
      await page.locator("#modal-username").fill("preview-test");
      await page.locator("#modal-display_name").fill("测试用户");
      await page.locator('#modal button[type="submit"]').click();
      await expect(page.locator(".secret-box")).toBeVisible();
      await capture("secret-delivery");
      await page.locator("[data-secret-done]").click();
      await ready("connections");
      await action("batch-connections");
      await expect(page.locator("#toast-region")).toContainText("请先选择连接");
      await capture("toast", "#toast-region");
      await page.route(/\/api\/v1\/admin\/devices(?:\?|$)/, (route) => route.fulfill({ json: { items: [], total: 0, total_pages: 1 } }));
      await ready("devices");
      await capture("devices-empty", "#app-shell");
      await ready("remote");
      await capture("native-remote", "#app-shell");
      await writeFile(resolve(output, "geometry.json"), JSON.stringify({ theme, width, results }, null, 2));
      expect(results.flatMap((r) => r.failures.map((failure) => `${r.view}: ${failure}`))).toEqual([]);
      await page.unrouteAll({ behavior: "wait" });
      await page.context().unrouteAll({ behavior: "wait" });
    });
  }
}

for (const theme of ["light", "dark"]) {
  for (const width of [1280, 1440, 1920, 2560, 390]) {
    test(`NestLink ${theme} ${width}px geometry and full-page screenshots`, async ({
      page,
      request,
    }) => {
      test.setTimeout(120_000);
      const output = resolve(artifactRoot, "screenshots", `${theme}-${width}`);
      await mkdir(output, { recursive: true });
      await request.post("/__preview/reset");
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript((value) => {
        localStorage.setItem("ht_theme", value);
        localStorage.setItem("ht_locale", "zh");
      }, theme);
      const results = [];
      for (const view of views) {
        await page.goto(`/admin#${view}`);
        await expect(page.locator("#app-shell")).toBeVisible();
        await expect(page.locator("#view-content")).toHaveAttribute("aria-busy", "false");
        await page.screenshot({
          path: resolve(output, `${view}.png`),
          fullPage: true,
          animations: "disabled",
        });
        results.push({ view, ...(await geometry(page)) });
      }
      await page.goto("/admin#connections");
      await page.locator('#page-actions [data-action="create-connection"]').click();
      await expect(page.locator("#modal[open]")).toBeVisible();
      await page.screenshot({
        path: resolve(output, "wizard-step-1.png"),
        fullPage: true,
        animations: "disabled",
      });
      results.push({ view: "wizard-step-1", ...(await geometry(page, "#modal")) });
      await page.keyboard.press("Escape");
      for (const endpoint of ["session", "refresh"]) {
        await page.route(`**/api/v2/auth/${endpoint}`, (route) =>
          route.fulfill({ status: 401, json: { error_code: "SESSION_REVOKED" } }),
        );
      }
      await page.goto("/admin");
      await expect(page.locator("#auth-screen")).toBeVisible();
      await page.screenshot({
        path: resolve(output, "login.png"),
        fullPage: true,
        animations: "disabled",
      });
      results.push({ view: "login", ...(await geometry(page, "#auth-screen")) });
      await writeFile(
        resolve(output, "geometry.json"),
        JSON.stringify({ theme, width, results }, null, 2),
      );
      expect(results.flatMap((r) => r.failures.map((failure) => `${r.view}: ${failure}`))).toEqual(
        [],
      );
    });
  }
}
