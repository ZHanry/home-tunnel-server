import assert from "node:assert/strict";
import test from "node:test";
import {
  physicalDevices,
  filterPhysicalDevices,
  deviceGroup,
} from "../public/modules/physical-devices.js";

const gui = {
  id: "gui",
  user_id: "owner",
  name: "Same name",
  credential_purpose: "gui",
  status: "active",
  online: false,
  tags: ["desk"],
};
const tunnel = {
  id: "tunnel",
  user_id: "owner",
  name: "Same name",
  credential_purpose: "background",
  status: "active",
  online: true,
  tags: ["home"],
};
const link = { physical_device_id: "gui", remote_device_id: "gui", tunnel_device_id: "tunnel" };

test("a complete snapshot merges subjects on different pages and preserves operation identities", () => {
  const rows = physicalDevices([gui, tunnel], [link], [], "owner");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "gui");
  assert.equal(rows[0].remote.id, "gui");
  assert.equal(rows[0].tunnel.id, "tunnel");
  assert.equal(rows[0].online, true);
  assert.deepEqual(rows[0].tags, ["desk", "home"]);
  assert.equal(filterPhysicalDevices(rows, { search: "home", status: "online" }).length, 1);
});

test("same names never imply an association and a forged foreign link cannot merge accounts", () => {
  assert.equal(physicalDevices([gui, tunnel], [], [], "owner").length, 2);
  const rows = physicalDevices(
    [gui, { ...tunnel, user_id: "foreign" }],
    [{ ...link, user_id: "owner" }],
    [],
    "owner",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tunnel, null);
});

test("revoking one capability preserves canonical identity and mobile grouping uses platform", () => {
  const rows = physicalDevices([tunnel], [{ ...link, remote_device_id: null }], [], "owner");
  assert.equal(rows[0].id, "gui");
  assert.equal(rows[0].remote, undefined);
  assert.equal(rows[0].tunnel.id, "tunnel");
  const mobile = physicalDevices(
    [{ ...gui, client_type: "android" }],
    [],
    [{ device_id: "gui", platform: "Android", remote_id: "123456", online: true }],
  );
  assert.equal(deviceGroup(mobile[0]), "mobile");
  assert.equal(filterPhysicalDevices(mobile, { search: "123456" }).length, 1);
});
