# Home Tunnel Server 10.1.0

This release promotes the original signed candidate from source commit
`194ae805f3569dc16d94b7fda71367e5d68fdff5` and candidate run
[36696725173](https://github.com/ZHanry/home-tunnel-server/actions/runs/36696725173).
The server packages and image digests are unchanged from that candidate.

## Changes

- Add scoped one-time native remote sign-in handoff
- Add safeguards against self-remote connections and current-device rename
- Freeze the additive `api-v1.5.0` contract; REST endpoints remain on `/api/v1`
- Keep remote desktop disabled by default and retain signed grants and discovered-capability checks

The intended component combination is Server/Web 10.1.0, desktop/CLI and managed
Agent 10.1.0, Android 10.0.0, and FRP 0.70.1. Android has not been relabeled as
10.1.0. This is a package release; it does not deploy or upgrade a production
console.

## Verification scope

The original server candidate passed CodeQL, secret scanning, component CI, and
production-path smoke plus isolated STUN checks on amd64 and arm64. The separate
acceptance record identifies any subsequent exact-digest revalidation by its real
run and execution timestamps. The source-pinned smoke client is the historical
9.0.0 compatibility baseline; this does not establish a complete 10.1.0
cross-product remote-desktop matrix.

A separate Windows native-worker run exercised the unchanged 10.1.0 client
worker and clean 10.1.0 server source on one Windows machine. It recorded 30 of 30
connections, 7202.463167 seconds of active media/input, and a 1539.1 ms input
watchdog release. That run did not execute the released server container images
or establish independent Windows endpoints, full installed GUI/service recovery,
public-network traversal, Android remote control, or network-outage recovery.

The following remain unverified for the final release build. They are not counted as passed:

- file transfer from host to viewer and fixed-password mode on the final build
- Android controlling a Windows host, independent Windows endpoints and full installed GUI/service recovery
- 2-hour and 24-hour soaks and the 30-connection repeat on the released server container images or complete installed application; the narrower exact-worker run above is separately identified
- IPv6, blocked-UDP and network-recovery matrix
- final deployment migration, backup restore and rollback
- full Gemini review of the final UI

No 24-hour online test was performed. See the attached `server-acceptance.json` and per-gate records for precise scope.

The candidate archive contains the documentation that was sealed with its
original build, including historical 10.0.0 release notes and then-pending
acceptance statements. Those original bytes are preserved for verification;
this release body and the separate acceptance record provide the current
publication status.

## Downloads

- [Server deployment archive](https://github.com/ZHanry/home-tunnel-server/releases/download/v10.1.0/home-tunnel-server-10.1.0.tar.gz)
- [Pinned Compose image overlay](https://github.com/ZHanry/home-tunnel-server/releases/download/v10.1.0/compose.release.yaml)

SHA-256:

```text
dea0300d37f275bc8b97a7069aad48df04c5ef424e9bbc484ffbd2b3d7ff2694  home-tunnel-server-10.1.0.tar.gz
6e7b3a9894c59e7cfc2d2dbbc3e0cc41f55c58c33865af7d6b3e75af38c9bba3  compose.release.yaml
```

Original files remain covered by `SHA256SUMS.txt` and its candidate Sigstore
bundle. Acceptance records are covered separately by
`server-acceptance.SHA256SUMS.txt` and its publication Sigstore bundle.

Before deploying, verify an encrypted backup can be restored and use the
release's Compose overlay to pin both image digests. Preserve existing database,
keys, domain and local Compose overrides.
