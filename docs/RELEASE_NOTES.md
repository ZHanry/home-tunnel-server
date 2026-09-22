# Home Tunnel 8.0.0-rc.1

This candidate adds the remote-desktop control plane under `/api/v1/rd` while
preserving the API v1 tunnel interface. The contract is 1.2.0; RD and the native
ABI have their own versions. Existing stable download and deployment defaults
remain 7.0.0. Use this candidate only in a separate test deployment and select
both candidate service images using the supplied `compose.release.yaml` overlay.

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
is supplied. Windows-to-Chromium desktop video has been exercised on one machine
in a development harness; that evidence does not establish cross-network or
full platform support. macOS/Wayland hosting, Android media decoding, system
audio, virtual microphone, native clipboard/files and enhanced codecs still
require implementation and acceptance. The final candidate's component reports
define the tested subset. This is not the final 8.0.0 release.

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
