import assert from "node:assert/strict";
import test from "node:test";
const fakeElement = {
  classList: { contains: () => true },
  dataset: { theme: "light" },
  style: {},
  matches: () => false,
  querySelectorAll: () => [],
  hasAttribute: () => false,
  setAttribute: () => undefined,
};
globalThis.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
globalThis.NodeFilter = { SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 };
globalThis.document = {
  nodeType: 9,
  body: {},
  documentElement: fakeElement,
  title: "",
  querySelector: (selector) => (selector === "#app-shell" ? fakeElement : null),
  querySelectorAll: () => [],
  createTreeWalker: () => ({ nextNode: () => null }),
};
globalThis.location = { pathname: "/admin" };
globalThis.window = {
  localStorage: { getItem: () => null, setItem: () => undefined },
  addEventListener: () => undefined,
  matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
};
globalThis.MutationObserver = class {
  observe() {}
};
const { homeDeskUrl, createNestLinkView } = await import("../public/modules/homedesk.js");

test("native launch never embeds credentials, config or a relay switch", () => {
  assert.equal(homeDeskUrl("123456789"), "homedesk://123456789");
  for (const id of [
    "123/r",
    "config?key=secret",
    "a@evil.example.com",
    "x#token",
    'x" onclick="',
    "",
    null,
  ]) {
    assert.equal(homeDeskUrl(id), null);
  }
});
test("a pending remote configuration cannot replace a closed view", async () => {
  const state = { renderId: 1 };
  const requests = [];
  const content = { innerHTML: "existing", querySelectorAll: () => [] };
  const api = async (path) => {
    requests.push(path);
    if (path.endsWith("config"))
      return { configured: true, server: "remote:21116", key_sha256: "key" };
    if (path.endsWith("homedesk/devices")) return { items: [] };
    return { items: [], total_pages: 2 };
  };
  const view = createNestLinkView({
    api,
    state,
    viewContent: content,
    escapeHtml: (value) => String(value),
  });
  const rendering = view.renderRemote();
  view.closeRemote();
  await rendering;
  assert.equal(content.innerHTML, "existing");
  assert.deepEqual(requests, ["/api/v2/homedesk/config"]);
});
