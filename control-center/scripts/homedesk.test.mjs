import assert from "node:assert/strict";
import test from "node:test";
import { homeDeskUrl, createHomeDeskView } from "../public/modules/homedesk.js";

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
test("directory pagination completes and a stale render cannot replace another view", async () => {
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
  const view = createHomeDeskView({
    api,
    state,
    viewContent: content,
    escapeHtml: (value) => String(value),
  });
  const rendering = view.renderRemote();
  view.closeRemote();
  await rendering;
  assert.equal(content.innerHTML, "existing");
  assert.ok(requests.some((path) => path.includes("page=2")));
});
