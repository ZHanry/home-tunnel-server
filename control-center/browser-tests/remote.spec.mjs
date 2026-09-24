import { test, expect } from "@playwright/test";

const hosts = Array.from({ length: 5 }, (_, index) => ({
  id: `10000000-0000-4000-8000-00000000000${index}`, name: `测试电脑 ${index + 1}`, role: "host",
  platform: "windows", status: "active", online: true, local_enabled: true,
  capabilities: { status: "ready", permissions: ["view", "input.keyboard", "input.text", "clipboard.read", "files.receive"], displays: [{ id: "display-1", name: "主屏幕", width: 1920, height: 1080 }] },
}));
async function ready(page, items = hosts) {
  await page.context().route("**/api/v1/public/capabilities", (route) => route.fulfill({ json: { remote_desktop: { enabled: true, stun_urls: ["stun:stun.example.test:3478"] } } }));
  await page.context().route("**/api/v1/rd/endpoints?**", (route) => route.fulfill({ json: { items } }));
  await page.goto("/admin#remote");
  await expect(page.locator("#view-content")).toHaveAttribute("aria-busy", "false");
}
async function openViewer(page, host = hosts[0]) {
  const popupPromise = page.waitForEvent("popup");
  await page.locator(`[data-remote-host="${host.id}"]`).click();
  const popup = await popupPromise;
  await expect(popup.locator(".remote-dialog")).toBeVisible();
  return popup;
}
test.afterEach(async ({ page, context }) => {
  await page.unrouteAll({ behavior: "wait" });
  await context.unrouteAll({ behavior: "wait" });
});

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

test("remote dashboard presents real devices and expandable details", async ({ page }) => {
  await ready(page, hosts.slice(0, 3));
  await expect(page.locator(".remote-dashboard-hero")).toContainText("像坐在电脑前一样");
  await expect(page.locator(".remote-device-card")).toHaveCount(3);
  await expect(page.locator(".remote-dashboard-heading")).toContainText("3 台在线可连接");
  await page.locator(".remote-device-details summary").first().click();
  await expect(page.locator(".remote-device-details").first()).toContainText(hosts[0].id);
  await page.locator("#app-shell [data-locale-toggle]").first().click();
  await expect(page.locator(".remote-dashboard-hero")).toContainText("Like you're right there");
  await expect(page.locator(".remote-dashboard-heading")).toContainText("3 available online");
});

test("trusted-device binding appears only when the host advertises unattended support", async ({ page }) => {
  const host = { ...hosts[0], capabilities: { ...hosts[0].capabilities, unattended_enabled: true } };
  await ready(page, [host, hosts[1]]);
  await expect(page.locator("[data-remote-trust]")).toHaveCount(1);
  const popupPromise = page.waitForEvent("popup");
  await page.locator(`[data-remote-trust="${host.id}"]`).click();
  const popup = await popupPromise;
  await expect(popup.locator(".remote-auth")).toBeVisible();
  await expect(popup.locator(".remote-auth legend")).toContainText("管理员批准");
  await expect(popup.locator(".remote-status")).toContainText("先验证账号");
  await popup.close();
});

test("a matching persistent grant connects without another pairing request", async ({ page }) => {
  const requests = [];
  const host = { ...hosts[0], owner_user_id: "fixture-owner", capabilities: { ...hosts[0].capabilities, unattended_enabled: true } };
  await page.context().exposeBinding("recordTrustedRequest", (_source, request) => { requests.push(request); });
  await page.context().route("**/modules/remote/http.js", (route) => route.fulfill({ contentType: "text/javascript", body: `
    export class RemoteError extends Error { constructor(code) { super(code); this.code = code; } }
    export class RemoteApi {
      constructor() { this.userId = "fixture-owner"; this.identity = { endpointId: "fixture-controller" }; }
      assertCurrent() {}
      async initialize() { return this; }
      async request(path, options = {}) {
        await window.recordTrustedRequest({ path, body: options.body });
        if (path.startsWith("/api/v1/rd/grants?")) return { items: [{ id: "fixture-grant", status: "active", mode: "persistent", host_endpoint_id: "${host.id}", controller_endpoint_id: "fixture-controller", permissions: ["view", "input.keyboard", "files.receive"], expires_at: new Date(Date.now() + 86400000).toISOString() }] };
        if (path === "/api/v1/rd/sessions" && options.method === "POST") return { session_id: "fixture-session" };
        if (path === "/api/v1/rd/sessions/fixture-session") return { state: "pending_approval" };
        return {};
      }
      close() {}
    }
  ` }));
  await page.context().route("**/modules/remote/signal.js", (route) => route.fulfill({ contentType: "text/javascript", body: `export class RemoteSignal { async connect() {} close() {} }` }));
  await ready(page, [host]);
  const popup = await openViewer(page, host);
  await expect.poll(() => requests.some((request) => request.path === "/api/v1/rd/sessions")).toBe(true);
  const creation = requests.find((request) => request.path === "/api/v1/rd/sessions");
  expect(creation.body.grant_id).toBe("fixture-grant");
  expect(creation.body.permissions).toEqual(["view", "input.keyboard"]);
  expect(requests.some((request) => request.path === "/api/v1/rd/pairings")).toBe(false);
  await popup.close();
});

test("temporary assistance redeems in a separate window without putting the password in its URL", async ({ page }) => {
  const requests = [];
  await page.context().exposeBinding("recordAssistRequest", (_source, request) => { requests.push(request); });
  await page.context().route("**/modules/remote/http.js", (route) => route.fulfill({ contentType: "text/javascript", body: `
    export class RemoteError extends Error { constructor(code) { super(code); this.code = code; } }
    export class RemoteApi {
      constructor() { this.userId = "guest-user"; this.identity = { endpointId: "guest-endpoint", jkt: "guest-jkt" }; this.keys = { server_instance_id: "fixture" }; }
      assertCurrent() {}
      async initialize() { return this; }
      async request(path, options = {}) {
        await window.recordAssistRequest({ path, body: options.body });
        if (path.endsWith("/assist-invites/redeem")) return {
          invite_id: "30000000-0000-4000-8000-000000000001", host_endpoint_id: "40000000-0000-4000-8000-000000000001",
          host_owner_user_id: "50000000-0000-4000-8000-000000000001", host_name: "协助电脑", host_jkt: "host-jkt", host_public_jwk: { kty: "EC" },
          capabilities: { status: "ready", permissions: ["view"], displays: [{ id: "main" }] },
        };
        if (path.endsWith("/pairings") && options.method === "POST") return new Promise(() => {});
        return {};
      }
      close() {}
    }
  ` }));
  await page.context().route("**/modules/remote/signal.js", (route) => route.fulfill({ contentType: "text/javascript", body: `export class RemoteSignal { async connect() {} close() {} }` }));
  await page.context().route("**/api/v1/rd/reauth", (route) => route.fulfill({ json: { verified_at: new Date().toISOString(), expires_at: new Date(Date.now() + 300000).toISOString() } }));
  await ready(page, []);
  const popupPromise = page.waitForEvent("popup");
  await page.locator("[data-remote-assist]").click();
  const popup = await popupPromise;
  await expect(popup.locator("[data-assist-form]")).toBeVisible();
  expect(popup.url()).not.toContain("temporary_password");
  await popup.locator('[name="access_mode"]').selectOption("temporary");
  await popup.locator('[name="device_id"]').fill("123456789");
  await popup.locator('[data-assist-form] [name="password"]').fill("OneTimeCode12");
  await popup.locator("[data-assist-form] button").click();
  await expect(popup.locator(".remote-dialog")).toBeVisible();
  await expect(popup.locator(".remote-auth legend")).toContainText("画面、键鼠与文本剪贴板");
  await expect(popup.locator(".remote-pairing")).toContainText("正在验证设备身份");
  await expect(popup.locator("[data-assist-form]")).toHaveCount(0);
  await expect.poll(() => requests.some((request) => request.path.endsWith("/pairings") && request.body?.assist_invite_id === "30000000-0000-4000-8000-000000000001")).toBe(true);
  await popup.close();
});

test("fixed password and approved requests open the same signed cross-account viewer", async ({ page }) => {
  const requests = [];
  await page.context().exposeBinding("recordAccessRequest", (_source, request) => { requests.push(request); });
  await page.context().route("**/modules/remote/http.js", (route) => route.fulfill({ contentType: "text/javascript", body: `
    export class RemoteError extends Error { constructor(code) { super(code); this.code = code; } }
    export class RemoteApi {
      constructor() { this.userId = "guest-user"; this.identity = { endpointId: "guest-endpoint", jkt: "guest-jkt" }; this.keys = { server_instance_id: "fixture" }; }
      assertCurrent() {}
      async initialize() { return this; }
      async request(path, options = {}) {
        await window.recordAccessRequest({ path, body: options.body });
        const target = {
          invite_id: "30000000-0000-4000-8000-000000000002", host_endpoint_id: "40000000-0000-4000-8000-000000000002",
          host_owner_user_id: "50000000-0000-4000-8000-000000000002", host_name: "跨账号电脑", host_jkt: "host-jkt", host_public_jwk: { kty: "EC" },
          capabilities: { status: "ready", permissions: ["view", "input.keyboard", "input.pointer", "clipboard.read", "clipboard.write"], displays: [{ id: "main" }] },
        };
        if (path.endsWith("/access/fixed/redeem")) return target;
        if (path === "/api/v1/rd/access/requests" && options.method === "POST") return { id: "60000000-0000-4000-8000-000000000002", expires_at: new Date(Date.now() + 120000).toISOString() };
        if (path.endsWith("/access/requests/60000000-0000-4000-8000-000000000002")) return { state: "approved", target };
        if (path.endsWith("/pairings") && options.method === "POST") return new Promise(() => {});
        return {};
      }
      close() {}
    }
  ` }));
  await page.context().route("**/modules/remote/signal.js", (route) => route.fulfill({ contentType: "text/javascript", body: `export class RemoteSignal { async connect() {} close() {} }` }));
  await ready(page, []);
  for (const mode of ["fixed", "request"]) {
    const priorPairings = requests.filter((request) => request.path === "/api/v1/rd/pairings").length;
    const popupPromise = page.waitForEvent("popup");
    await page.locator("[data-remote-assist]").click();
    const popup = await popupPromise;
    await popup.locator('[name="access_mode"]').selectOption(mode);
    await popup.locator('[name="device_id"]').fill("123456789");
    if (mode === "fixed") await popup.locator('[data-assist-form] [name="password"]').fill("strong-fixed-password");
    await popup.locator("[data-assist-form] button").click();
    await expect(popup.locator(".remote-dialog")).toBeVisible();
    await expect.poll(() => requests.filter((request) => request.path === "/api/v1/rd/pairings" && request.body?.assist_invite_id === "30000000-0000-4000-8000-000000000002").length).toBe(priorPairings + 1);
    if (mode === "fixed") {
      expect(requests.find((request) => request.path.endsWith("/access/fixed/redeem"))?.body.password).toBe("strong-fixed-password");
      expect(popup.url()).not.toContain("strong-fixed-password");
    } else expect(requests.some((request) => request.path === "/api/v1/rd/access/requests")).toBe(true);
    await popup.close();
  }
});

test("desktop device deep link opens only its matching remote window", async ({ page }) => {
  const matched = { ...hosts[0], linked_device_id: "20000000-0000-4000-8000-000000000001" };
  await ready(page, [matched, hosts[1]]);
  await page.goto(`/admin?remoteDevice=${matched.linked_device_id}#remote`);
  await expect(page.locator(".remote-dialog")).toBeVisible();
  await expect(page.locator(".remote-dialog .remote-header")).toContainText(matched.name);
  await expect(page.locator(".remote-dialog .remote-header")).not.toContainText(hosts[1].name);
});

test("an unapproved viewer cannot expose enabled input or data controls", async ({ page }) => {
  await ready(page, [{ ...hosts[0], capabilities: { ...hosts[0].capabilities, permissions: ["view"] } }]);
  const popup = await openViewer(page);
  for (const selector of ["[data-input]", "[data-release]", "[data-audio]", "[data-microphone]", "[data-clipboard]", "[data-files]", ".remote-text button", "[data-file-send]"]) {
    await expect(popup.locator(".remote-dialog").locator(selector)).toBeDisabled();
  }
  await expect(popup.locator('[name="permission"]')).toHaveCount(1);
  await popup.close();
});

test("viewer toolbar keeps its icons and disabled state when labels change", async ({ page }) => {
  await ready(page, [{ ...hosts[0], capabilities: { ...hosts[0].capabilities, permissions: ["view"] } }]);
  const popup = await openViewer(page);
  const dialog = popup.locator(".remote-dialog");
  for (const selector of ["[data-input]", "[data-audio]", "[data-microphone]", "[data-clipboard]", "[data-files]"]) {
    await expect(dialog.locator(`${selector} svg`)).toHaveCount(1);
    await expect(dialog.locator(selector)).toBeDisabled();
  }
  await popup.evaluate(async () => {
    const { setToolLabel } = await import("/modules/remote/view.js");
    setToolLabel(document.querySelector(".remote-dialog"), "[data-clipboard]", "关闭文本剪贴板", true);
  });
  await expect(dialog.locator("[data-clipboard] span")).toHaveText("关闭文本剪贴板");
  await expect(dialog.locator("[data-clipboard] svg")).toHaveCount(1);
  await expect(dialog.locator("[data-clipboard]")).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.locator("[data-clipboard]")).toBeDisabled();
  await popup.close();
});

test("separate viewer windows retain independent drafts", async ({ page }) => {
  await ready(page, hosts.slice(0, 2));
  const first = await openViewer(page, hosts[0]);
  const second = await openViewer(page, hosts[1]);
  await first.locator('.remote-dialog [name="password"]').fill("draft");
  await second.locator(".remote-dialog [data-close]").click();
  await expect.poll(() => second.isClosed()).toBe(true);
  await expect(first.locator('.remote-dialog [name="password"]')).toHaveValue("draft");
  await expect(page.locator(".remote-dialog")).toHaveCount(0);
  await first.close();
});

test("reauthentication failure clears secrets and never enrolls the browser", async ({ page }) => {
  let enrollments = 0;
  await ready(page, [hosts[0]]);
  await page.context().route("**/api/v1/rd/reauth", (route) => route.fulfill({ status: 403, json: { error_code: "RD_REAUTH_REQUIRED", message: "密码验证失败" } }));
  await page.context().route("**/api/v1/rd/enrollment-challenges", (route) => { enrollments++; return route.fulfill({ status: 500 }); });
  const popup = await openViewer(page);
  const dialog = popup.locator(".remote-dialog");
  await dialog.locator('[name="password"]').fill("not-a-real-secret");
  await dialog.locator(".remote-auth button[type=submit]").click();
  await expect(dialog.locator(".remote-error")).toContainText("密码验证失败");
  await expect(dialog.locator('[name="password"]')).toHaveValue("");
  await expect(dialog.locator(".remote-viewer")).toBeHidden();
  expect(enrollments).toBe(0);
  await popup.close();
});

test("account expiration closes the remote viewer window", async ({ page }) => {
  await ready(page, [hosts[0]]);
  const popup = await openViewer(page);
  await popup.evaluate(() => window.dispatchEvent(new Event("session-expired")));
  await expect.poll(() => popup.isClosed()).toBe(true);
  await expect(page.locator(".remote-dialog")).toHaveCount(0);
});

test("closing during pairing creation waits and revokes the late invitation", async ({ page }) => {
  const requests = [];
  await page.context().exposeBinding("recordRemoteRequest", (_source, request) => { requests.push(request); });
  await page.context().route("**/modules/remote/http.js", (route) => route.fulfill({ contentType: "text/javascript", body: `
    window.rdCloseTest = { resolvePair: null };
    export class RemoteError extends Error { constructor(code) { super(code); this.code = code; } }
    export class RemoteApi {
      constructor() { this.identity = { endpointId: "controller", jkt: "controller-jkt" }; this.keys = { server_instance_id: "fixture" }; }
      assertCurrent() {}
      async initialize() { return this; }
      request(path, options = {}) {
        void window.recordRemoteRequest({ path, method: options.method });
        if (path === "/api/v1/rd/pairings" && options.method === "POST") return new Promise((resolve) => { window.rdCloseTest.resolvePair = resolve; });
        return Promise.resolve({});
      }
      close() { window.rdCloseTest.closed = true; }
    }
  ` }));
  await page.context().route("**/modules/remote/signal.js", (route) => route.fulfill({ contentType: "text/javascript", body: `
    export class RemoteSignal { async connect() {} close() {} }
  ` }));
  await ready(page, [hosts[0]]);
  const popup = await openViewer(page);
  await expect.poll(() => popup.evaluate(() => !!window.rdCloseTest.resolvePair)).toBe(true);
  await popup.locator(".remote-dialog [data-close]").click();
  expect(await popup.isClosed()).toBe(false);
  await popup.evaluate(() => window.rdCloseTest.resolvePair({ id: "30000000-0000-4000-8000-000000000001" }));
  await expect.poll(() => requests.some((request) => request.path.endsWith("/reject"))).toBe(true);
  await expect.poll(() => popup.isClosed()).toBe(true);
});

test("closing during session creation revokes the grant and closes the late session", async ({ page }) => {
  const requests = [];
  await page.context().exposeBinding("recordRemoteRequest", (_source, request) => { requests.push(request); });
  await page.context().route("**/modules/remote/http.js", (route) => route.fulfill({ contentType: "text/javascript", body: `
    import { canonicalJson } from "/modules/remote/protocol.js";
    import { sha256 } from "/modules/remote/identity.js";
    window.rdCloseTest = { resolveSession: null };
    export class RemoteError extends Error { constructor(code) { super(code); this.code = code; } }
    export class RemoteApi {
      constructor() { this.identity = { endpointId: "controller", jkt: "controller-jkt" }; this.keys = { server_instance_id: "fixture" }; }
      assertCurrent() {}
      async initialize() {
        this.identity.privateKey = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])).privateKey;
        return this;
      }
      async request(path, options = {}) {
        void window.recordRemoteRequest({ path, method: options.method });
        if (path === "/api/v1/rd/pairings" && options.method === "POST") {
          const body = options.body;
          this.transcript = { domain: "ht-rd-pairing-v1", pairing_id: "30000000-0000-4000-8000-000000000001", server_instance_id: "fixture",
            host_endpoint_id: body.host_endpoint_id, controller_endpoint_id: "controller", host_jkt: "host-jkt", controller_jkt: "controller-jkt",
            nonce_controller: body.nonce_controller, nonce_host: "host-nonce", scope: body.permissions, mode: "one_session",
            session_request_id: body.session_request_id, expires_at: new Date(Date.now() + 60000).toISOString() };
          return { id: this.transcript.pairing_id };
        }
        if (path.endsWith("/confirm")) return { state: "confirmed", grant_id: this.transcript.pairing_id };
        if (path === "/api/v1/rd/sessions" && options.method === "POST") return new Promise((resolve) => { window.rdCloseTest.resolveSession = resolve; });
        if (path === "/api/v1/rd/pairings/" + this.transcript.pairing_id && !options.method) {
          const digest = await sha256(canonicalJson(this.transcript));
          const code = Array.from(digest.subarray(0, 16), (number) => number.toString(16).padStart(2, "0")).join("").match(/.{4}/g).join("-");
          return { id: this.transcript.pairing_id, state: "pending", transcript: this.transcript, display_code: code };
        }
        return {};
      }
      close() { window.rdCloseTest.closed = true; }
    }
  ` }));
  await page.context().route("**/modules/remote/signal.js", (route) => route.fulfill({ contentType: "text/javascript", body: `
    export class RemoteSignal { async connect() {} close() {} }
  ` }));
  await ready(page, [{ ...hosts[0], jkt: "host-jkt" }]);
  const popup = await openViewer(page);
  await expect.poll(() => popup.evaluate(() => !!window.rdCloseTest.resolveSession)).toBe(true);
  await popup.locator(".remote-dialog [data-close]").click();
  expect(await popup.isClosed()).toBe(false);
  await popup.evaluate(() => window.rdCloseTest.resolveSession({ session_id: "40000000-0000-4000-8000-000000000001" }));
  await expect.poll(() => requests.some((request) => request.path === "/api/v1/rd/sessions/40000000-0000-4000-8000-000000000001/close")).toBe(true);
  await expect.poll(() => requests.some((request) => request.path === "/api/v1/rd/pairings/30000000-0000-4000-8000-000000000001/reject")).toBe(true);
  await expect.poll(() => popup.isClosed()).toBe(true);
});

test("the separate viewer remains scrollable at 720px with file and clipboard panels", async ({ page }) => {
  await ready(page, [hosts[0]]);
  const popup = await openViewer(page);
  await popup.setViewportSize({ width: 1280, height: 720 });
  await popup.locator(".remote-dialog").evaluate((dialog) => {
    dialog.querySelector(".remote-auth").hidden = true; dialog.querySelector(".remote-viewer").hidden = false;
    dialog.querySelector("[data-clipboard-panel]").hidden = false; dialog.querySelector("[data-file-panel]").hidden = false;
  });
  const button = popup.locator("[data-file-send]"); await button.scrollIntoViewIfNeeded();
  await expect(button).toBeInViewport();
  expect(await popup.locator(".remote-dialog").evaluate((dialog) => dialog.scrollTop)).toBeGreaterThan(0);
  await popup.close();
});
