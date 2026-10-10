import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const owner = "5f70df22-86df-4b52-b9ca-083f8adb70bb";
const gui = "11111111-1111-4111-8111-111111111111";
const tunnel = "22222222-2222-4222-8222-222222222222";
const phone = "33333333-3333-4333-8333-333333333333";
const subject = (id, purpose, platform, name = "共享名称") => ({
  id, user_id: owner, username: "lin", name, status: "active", online: true,
  credential_purpose: purpose, client_type: platform, tags: [], metadata_version: 1,
  last_seen_at: "2026-10-10T08:00:00Z", client_version: "14.0.0",
});

async function fixture(page) {
  await page.route(/\/api\/v1\/client\/devices(?:\?|$)/, route => {
    const second = new URL(route.request().url()).searchParams.get("page") === "2";
    return route.fulfill({ json: {
      items: second ? [subject(tunnel,"background","linux")] : [subject(gui,"gui","windows"),subject(phone,"gui","android","手机")],
      total: 3,total_pages: 2,page: second ? 2 : 1,page_size:100,
    }});
  });
  await page.route("**/api/v2/auth/device-capabilities", route => route.fulfill({json:{version:1,items:[{
    physical_device_id:gui,remote_device_id:gui,tunnel_device_id:tunnel,
  }]}}));
  await page.route("**/api/v2/homedesk/devices", route => route.fulfill({json:{version:2,items:[{
    device_id:gui,remote_id:"123456789",platform:"Windows",online:true,server:"hbbs.example.com:21116",key_sha256:"ab".repeat(32),
  }]}}));
}

test.beforeEach(async ({request}) => { await request.post("/__preview/reset"); });
test.afterEach(async ({page}) => { await page.unrouteAll({behavior:"wait"}); });

test("physical directory joins pages before filtering and preserves GUI/tunnel action identities", async ({page}) => {
  await fixture(page);await page.goto("/admin?role=user#devices");
  await expect(page.locator(".device-directory-row")).toHaveCount(2);
  await expect(page.locator(`[data-physical-device="${gui}"]`)).toContainText("远程协助 在线");
  await expect(page.locator(`[data-physical-device="${gui}"]`)).toContainText("内网穿透 在线");
  await expect(page.locator(`[data-physical-device="${tunnel}"]`)).toHaveCount(0);
  await expect(page.locator('[data-device-group="mobile"]')).toContainText("手机");
  await page.locator('#device-search-form input[name="search"]').fill("123456789");
  await page.locator('#device-search-form button[type="submit"]').click();
  await expect(page.locator(".device-directory-row")).toHaveCount(1);
  await page.locator('[data-action="device-info"]').click();
  await page.locator('[data-action="device-metadata"]').click();
  await page.locator('#modal-tags').fill("标签");
  let metadata;
  await page.route(`**/api/v1/client/devices/${gui}/metadata`, route => {
    metadata = route.request().postDataJSON();return route.fulfill({json:{}});
  });
  await page.locator('#modal button[type="submit"]').click();
  await expect.poll(()=>metadata?.tags).toEqual(["标签"]);
  expect(metadata.favorite).toBeUndefined();
  await expect(page.locator("#modal")).toBeHidden();
  await page.locator('[data-action="device-info"]').click();
  await expect(page.locator('[data-action="device-services"]')).toHaveAttribute("data-id",tunnel);
  await page.locator('[data-action="remove-physical-device"]').click();
  await expect(page.locator("#modal")).toContainText("保留服务配置");
  const deletion = page.waitForRequest(request => request.method()==="DELETE" && request.url().endsWith(`/api/v2/auth/devices/${gui}`));
  await page.route(`**/api/v2/auth/devices/${gui}`,route=>route.fulfill({status:204}));
  await page.locator('#modal button[type="submit"]').click();await deletion;
});

test("refresh retains directory positions and errors do not masquerade as missing extensions", async ({page}) => {
  await fixture(page);await page.goto("/admin?role=user#devices");
  await expect(page.locator(".device-directory-row")).toHaveCount(2);
  const before=await page.locator(`[data-physical-device="${gui}"]`).boundingBox();
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  await page.route("**/api/v2/auth/device-capabilities",async route=>{
    await pending;return route.fulfill({status:503,json:{error_code:"TEMPORARILY_UNAVAILABLE",message:"Capability directory unavailable"}});
  });
  await page.locator('[data-action="refresh-view"]').click();
  await expect(page.locator(".device-directory-row")).toHaveCount(2);
  expect((await page.locator(`[data-physical-device="${gui}"]`).boundingBox()).y).toBe(before.y);
  await expect(page.locator('[data-action="refresh-view"]')).toHaveAttribute("aria-busy","true");
  release();await expect(page.locator('#view-content')).toHaveAttribute('aria-busy','false');
  await expect(page.locator(".device-directory-row")).toHaveCount(2);
});

for (const theme of ["light","dark"]) for (const width of [320,390,768,1440]) {
  test(`shared lavender workspace ${theme} ${width}px supports larger controls and top preferences`, async ({page})=>{
    await fixture(page);await page.emulateMedia({colorScheme:theme,reducedMotion:"reduce"});
    await page.setViewportSize({width,height:960});
    await page.goto("/admin?role=user#devices");await expect(page.locator(".device-directory-row")).toHaveCount(2);
    await expect(page.locator(".nav-primary")).toHaveCount(3);
    await expect(page.locator('.product-bar [data-locale-toggle]')).toBeVisible();
    await expect(page.locator('#version-button')).toBeVisible();
    await expect(page.locator('#current-version')).not.toBeVisible();
    const output=resolve('../outputs/nestlink-web-14/current');await mkdir(output,{recursive:true});
    await page.screenshot({path:resolve(output,`devices-zh-${theme}-${width}.png`),fullPage:true,animations:'disabled'});
    await page.locator('.product-bar [data-locale-toggle]').click();
    await page.addStyleTag({content:'.directory-tools input,.directory-tools select,.directory-tools button{font-size:18px;}'});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:resolve(output,`devices-${theme}-${width}.png`),fullPage:true,animations:'disabled'});
  });
}
