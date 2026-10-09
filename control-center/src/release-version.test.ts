import assert from "node:assert/strict";
import test from "node:test";
import { compareReleaseVersions, parseReleaseVersion } from "./release-version.js";

test("RC1 spelling is supported without changing the stable channel ordering", async () => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    INTERNAL_SERVICE_KEY: "11".repeat(32),
    FRPS_PLUGIN_KEY: "22".repeat(32),
    LEASE_SIGNING_KEY: "33".repeat(32),
  });
  const { eligibleRelease } = await import("./routes/public-v2.js");
  assert.ok(parseReleaseVersion("v12.0.0-RC1"));
  assert.equal(compareReleaseVersions("12.0.0-RC10", "12.0.0-RC2"), 1);
  assert.equal(compareReleaseVersions("12.0.0-RC1", "12.0.0-rc.1"), 0);
  assert.equal(compareReleaseVersions("12.0.0", "12.0.0-RC10"), 1);
  assert.equal(compareReleaseVersions("12.0.0-RC1", "11.99.99"), 1);
  assert.equal(
    eligibleRelease({ draft: false, prerelease: true, tag_name: "v12.0.0-RC1" }, "stable"),
    null,
  );
  assert.equal(
    eligibleRelease({ draft: false, prerelease: true, tag_name: "v12.0.0-RC1" }, "rc")?.version,
    "12.0.0-RC1",
  );
  assert.equal(
    eligibleRelease({ draft: false, prerelease: false, tag_name: "v12.0.0-RC1" }, "rc"),
    null,
  );
  assert.equal(
    eligibleRelease({ draft: true, prerelease: true, tag_name: "v12.0.0-RC1" }, "rc"),
    null,
  );
  for (const value of ["12.0.0-RC0", "012.0.0", "12.0", "v12.0.0-RC1/evil"])
    assert.equal(parseReleaseVersion(value), null);
});
