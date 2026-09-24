# Home Tunnel Server 9.0.0

This release adds three authenticated remote-access modes: a host-approved
request, a reusable fixed password, and a single-use temporary password.
Cross-account sessions use short-lived invitations, signed grants and leases;
existing same-account device queries remain isolated. The website separates
tunnels and remote desktop and opens the viewer in its own window. API contract
`api-v1.3.0` adds the corresponding endpoints and schemas.

Remote desktop remains disabled by default. It requires matching 9.0.0 clients
and a direct UDP path; no media relay or TURN fallback is provided. Windows
lock-screen, login-screen and UAC secure-desktop control are not established.
Audio and full clipboard interoperability are not established, and Android
arm64 runtime was not exercised by the x86_64 emulator acceptance. Consult the
component evidence before enabling any capability.

Before deploying, verify an encrypted backup can be restored. Preserve the
existing database, keys, domain and Compose overrides; use the published image
digests and validate old tunnels and new remote sessions before promoting.

## Previous release: 8.0.0

This release adds the remote-desktop control plane under `/api/v1/rd` while
preserving the API v1 tunnel interface. The contract is 1.2.0; RD and the native
ABI have their own versions. Deployment defaults select 8.0.0. Verify the
deployment archive and use its `compose.release.yaml` overlay to select both
service images by their published immutable digests. Validate upgrades in a
separate deployment before migrating an existing database.

- Add endpoint keys, DPoP, explicit pairing and host-local session approval,
  ES256 tickets and leases, persistent quotas, revocation and bounded signaling.
- Add a browser viewer with permission-gated input, display selection and
  diagnostics. Features remain unavailable when the selected host lacks the
  required backend or permission.
- Add additive database migrations, validated migration history, independent
  signing keys and chained rotation. Encrypted recovery advances `restore_epoch`,
  closes previous sessions and leaves RD disabled until locally re-authorized.
- Provide a pinned STUN-only deployment, firewall limits and isolated runtime
  checks. It cannot replace real public-network traversal and bandwidth tests.
- Publish API/RD contracts and authorization vectors alongside image identities,
  deployment archives, checksums, build evidence and integration reports.

RD is off by default. All remote payloads require direct UDP; no relay fallback
is supplied. Development tests have exercised Windows-to-Chromium H.264 and VP8
video, keyboard/pointer/Unicode input and stale input rejection on one machine.
The input test observed held-input release within two seconds after heartbeat
loss and worker termination. A separate same-machine test transferred actual
files in both directions over the data channel, checked their bytes and hashes,
and confirmed viewing continued after file permissions were disabled. File
selection used isolated test fixtures; the native and browser file pickers were
not exercised. These results use development builds, not the final signed or
packaged release bytes. The release's attached acceptance report identifies the
exact distributed worker that passed final native verification.

The control plane and these Windows paths are implemented. Package installation,
update/recovery and exact-artifact verification are separate checks; consult the
attached component reports for their outcomes. Cross-network traversal and the full platform matrix remain
unverified. macOS/Wayland hosting, desktop native viewing, Android media decoding,
system audio, virtual microphone and AV1/HEVC remain incomplete. Linux X11 and
native text clipboard support also require platform and end-to-end acceptance.
The 8.0.0 version identifies this release and does not establish acceptance for
those unavailable or unverified capabilities. Component reports define the
tested subset and unavailable features.

Before upgrading, retain a verified encrypted backup. Prefer disabling RD as
rollback; do not run a 7.0 server against a migrated 8.0 database. Recovery must
use the documented fresh-project/empty-volume procedure. See
[remote desktop operations](REMOTE_DESKTOP_OPERATIONS.md).

## Previous stable release: 7.0.0

All first-party components and the managed Agent now use 7.0.0. Upgrade the server,
desktop/CLI and Android together; FRP remains at its independent 0.70.1 version.

- Fix Web multi-tab refresh, stale access-policy writes and persistent backup health.
- Reject unverified/incomplete desktop updates and use stable semantic versions.
- Add full REST OpenAPI/JSON Schema and capability-driven Android transport controls.
- Add TOTP/recovery codes, session management and single-use enrollment codes.
- Add OS credential protection, redacted diagnostics and host-only admin recovery.
- Add encrypted off-host backup, verified fresh-volume restore, preflight/NAS
  templates, monitoring and alert rules.
- Add encrypted Android server profiles, tags/favorites and per-item batch operations.
- Publish checksums, SBOMs, provenance and verification evidence as durable assets.

Windows/macOS have no publisher certificates configured and are explicitly unsigned;
their signing/notarization workflow is ready. Android retains its release signing
identity. Read the migration and platform-security guides before upgrading.
