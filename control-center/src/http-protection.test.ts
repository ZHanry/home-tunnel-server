import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.SQLITE_PATH = ":memory:";
process.env.INTERNAL_SERVICE_KEY = "11".repeat(32);
process.env.FRPS_PLUGIN_KEY = "22".repeat(32);
process.env.LEASE_SIGNING_KEY = "33".repeat(32);
process.env.COOKIE_SECURE = "false";

const { parseBearerToken } = await import("./http.js");
const { createApplication } = await import("./server.js");

test("bearer parsing is bounded and rejects whitespace-only and malformed tokens", () => {
  assert.equal(parseBearerToken("Bearer opaque-token_123"), "opaque-token_123");
  assert.equal(parseBearerToken("bEaReR   token+/="), "token+/=");
  for (const value of [
    undefined,
    "",
    "Basic token",
    "Bearer",
    "Bearer ",
    "Bearer token extra",
    "Bearer token\n",
    "Bearer " + " ".repeat(100_000),
  ]) {
    assert.equal(parseBearerToken(value), undefined);
  }
});

test("API budgets reject excess work without consuming the separate page budget", async () => {
  const app = await createApplication(false, {
    apiRequestsPerMinute: 2,
    publicRequestsPerMinute: 2,
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    for (let index = 0; index < 2; index++) {
      const response = await fetch(origin + "/api/v1/public/config");
      assert.equal(response.status, 200);
      await response.text();
    }
    const limited = await fetch(origin + "/api/v1/public/config");
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    assert.equal((await limited.json()).error_code, "RATE_LIMITED");

    for (const path of ["/", "/admin"]) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 200);
      await response.text();
    }
    const pageLimited = await fetch(origin + "/another-console-page");
    assert.equal(pageLimited.status, 429);
    await pageLimited.text();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
