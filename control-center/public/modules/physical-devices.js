// A directory row is a physical identity, while operations retain subject UUIDs.
// This module is deliberately independent of the DOM and authentication state.
export function physicalDevices(subjects, links, bindings = [], ownerId = null) {
  const byId = new Map(subjects.map(subject => [subject.id, subject]));
  const bindingById = new Map(bindings.map(binding => [binding.device_id, binding]));
  const used = new Set();
  const rows = [];
  const active = subject => subject?.status === "active" && !subject.revoked_at;
  const make = (physicalId, remote, tunnel, linked, owner) => {
    const base = remote ?? tunnel;
    if (!base) return;
    const binding = remote ? bindingById.get(remote.id) : null;
    rows.push({
      ...base,
      id: physicalId,
      user_id: owner,
      remote,
      tunnel,
      binding,
      linked,
      subject_ids: [remote?.id, tunnel?.id].filter(Boolean),
      tags: [...new Set([...(remote?.tags ?? []), ...(tunnel?.tags ?? [])])],
      platform: binding?.platform ?? remote?.client_type ?? tunnel?.client_type ?? "",
      online: Boolean((active(remote) && (binding?.online ?? remote.online)) || (active(tunnel) && tunnel.online)),
      remote_ready: Boolean(active(remote) && binding?.online),
      tunnel_ready: Boolean(active(tunnel) && tunnel.online),
      metadata_subject: active(remote) ? remote : active(tunnel) ? tunnel : base,
    });
  };
  for (const link of links) {
    const remote = byId.get(link.remote_device_id);
    const tunnel = byId.get(link.tunnel_device_id);
    const owner = link.user_id ?? ownerId ?? remote?.user_id ?? tunnel?.user_id;
    if (ownerId && owner !== ownerId) continue;
    // The server is authoritative; still reject inconsistent cross-account data.
    if ([remote, tunnel].some(subject => subject && subject.user_id !== owner)) continue;
    if (remote && remote.credential_purpose !== "gui") continue;
    if (tunnel && tunnel.credential_purpose !== "background") continue;
    if (remote) used.add(remote.id);
    if (tunnel) used.add(tunnel.id);
    make(link.physical_device_id, remote, tunnel, true, owner);
  }
  for (const subject of subjects) {
    if (used.has(subject.id) || (ownerId && subject.user_id !== ownerId)) continue;
    const remote = subject.credential_purpose === "gui" || bindingById.has(subject.id);
    make(subject.id, remote ? subject : null, remote ? null : subject, false, subject.user_id);
  }
  return rows;
}

export function filterPhysicalDevices(rows, { search = "", status = "all" } = {}) {
  const query = search.trim().toLocaleLowerCase();
  return rows.filter(row => (!query || [row.name, row.binding?.remote_id, row.id, row.username, ...row.tags]
    .filter(Boolean).join(" ").toLocaleLowerCase().includes(query)) &&
    (status === "all" || (status === "online" ? row.online : !row.online)));
}

export function deviceGroup(row) {
  return /android|ios|iphone|ipad|mobile/i.test(row.platform) ? "mobile" : "computer";
}
