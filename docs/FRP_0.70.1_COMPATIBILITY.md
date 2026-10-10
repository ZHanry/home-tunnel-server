# FRP 0.70.1 compatibility and reviewed dependency record

NestLink 14.0.0 pins the reviewed `0.70.1-r4` FRPS dependency in its Compose
and preparation defaults. This record establishes the dependency identity and
build checks. Application installation and remote-control acceptance are tracked
separately in the version-specific signed release record.

Dependency review updated: 2026-10-10

Managed TCP/UDP extension design review: 2026-08-21

| Input | Reviewed identity |
| --- | --- |
| FRP release | `v0.70.1` (2026-07-23) |
| Upstream commit | `fa3bcca2b0c4753cd4f0e2ab189dd6a5a6a15708` |
| GitHub API source archive SHA-256 | `9c6b0188a8f74e982069dc89218cc3d79bada8663cedf3b514b98847530cbf7d` |
| FRPS image tag | `ghcr.io/zhanry/home-tunnel-frps:0.70.1-r4` |
| FRPS multi-architecture digest | `sha256:69dd1e9a05dbef35f44436db77f88e266a2772d57a86f889ffbd982ca7798ddb` |
| Protected FRPS workflow revision | `0ad5a6d0e463d8d1b496e0642bf8b010ba3ec263` |
| Protected FRPS workflow | [run 38052783144](https://github.com/ZHanry/home-tunnel-server/actions/runs/38052783144) |
| Build toolchain | Go `1.27.2` |
| Reviewed Go security modules | NTLM `v0.1.1`, crypto `v0.57.0`, net `v0.60.0`, WebSocket `v1.5.3` |

## Decision

The upstream FRP tree remains fixed at 0.70.1. Revision r4 updates the actual
FRPS build locks and Go toolchain to address the current HTTP/2 and standard
library advisories. The dependency workflow verifies the upstream tag/archive,
copies the reviewed `go.mod`/`go.sum`, builds with `-tags noweb`, and rejects
OpenPGP imports. `go vet` and `govulncheck` 1.6.0 pass with zero vulnerable
imported packages or reachable symbols. The remaining module-level
GO-2026-5932 concerns the excluded OpenPGP package.

The protected workflow built and published `linux/amd64` and `linux/arm64`,
checked the baked L4/Ping entrypoint and rendered allow-port range, and produced
SBOM, provenance, GitHub attestations and keyless Cosign signatures. Independent
verification checks both the signed dependency manifest and image against
`frps-image.yml@refs/heads/main`, the exact workflow source revision, and the
GitHub OIDC issuer. The immutable revision tag resolves to the digest above.

The managed Agent reports NestLink product version `14.0.0` and uses the same
pinned FRP source. The desktop release publishes `NestLink-Setup-14.0.0-x64.exe`,
`NestLink-Linux-14.0.0-x64.deb` and `NestLink-Linux-14.0.0-arm64.deb`.
Installed application and configuration identities remain compatible for upgrades.
Checksums, SPDX SBOMs, provenance and attestations remain required for the final
application artifacts. Windows
Authenticode signing, a clean Windows 10/11 upgrade matrix and macOS release
acceptance are outside the verified scope of this dependency record.

## Dependency evidence

| Gate | Result | Evidence |
| --- | --- | --- |
| Official tag and source identity | Pass | Protected run 38052783144 resolves the exact upstream commit and checks the recorded API archive SHA-256. |
| FRPS static and vulnerability checks | Pass | The reviewed Go locks and Go 1.27.2 pass `go vet` and `govulncheck`; OpenPGP is absent from the imported graph. |
| Linux architecture matrix | Pass | The actual published OCI index contains exactly `linux/amd64` and `linux/arm64` application manifests. |
| Baked L4/Ping configuration | Pass | The workflow checks the allow-port placeholder, `Login`/`NewProxy`/`CloseProxy`/`Ping` operations and UDP switch, then runs the entrypoint with an explicit L4 port range. |
| Dependency supply chain | Pass | Manifest and image Cosign signatures and GitHub attestations verify against the exact protected source; the original Actions artifact ZIP matches GitHub's SHA-256 digest. |
| Managed protocol and application release smoke | Required application gate | `tests/run-release-smoke.sh` checks real HTTP/TCP/UDP/RTSP and Ping revocation using the final application images and managed Agent; this dependency record does not substitute for that run. |

## Required source adaptations

FRP 0.70.1 is not a pin-only upgrade:

1. `client.ServiceOptions` no longer accepts `ProxyCfgs`/`VisitorCfgs`. The
   restricted Agent creates a `source.ConfigSource`, populates it with the
   already-validated proxies, wraps it in `source.Aggregator`, and passes an
   empty `security.UnsafeFeatures` set.
2. `ProxyConfigurer.Complete` no longer accepts a user argument. User prefixes
   are applied at the wire layer; the local whitelist compares unprefixed names
   while the FRPS plugin still sees the prefixed wire name.
3. `validation.ValidateAllClientConfig` requires an unsafe-feature policy.
   NestLink passes `security.NewUnsafeFeatures(nil)`.
4. A fresh FRP checkout lacks built dashboard assets. FRPS is built with
   `-tags noweb`; NestLink does not expose the FRPS dashboard.

## Dependency validation

- [x] Keep the exact upstream identity and `-tags noweb` build.
- [x] Use the reviewed Go 1.27.2 toolchain and actual module locks.
- [x] Build, audit, check the baked entrypoint, sign and attest r4 for both Linux architectures.
- [x] Verify the original signed manifest, image attestations and immutable tag.
- [x] Pin the same r4 digest in Compose, the hbbs preparation helper and runtime test fixture.

Application releases continue to require exact-source build, package, image,
integration and signed acceptance gates. The managed Agent resource hash stays
fail-closed, and Windows resource builds retain `SOURCE_DATE_EPOCH=0`.

The dependency record does not establish production support for an application
or acceptance for platforms and scenarios that were not actually exercised.

## Managed L4 scope

The 2026-08-21 application extension keeps the reviewed FRP dependency and
restricts its additional surface to general TCP and fixed-port UDP proxies.
Both transports are disabled by default. The control center assigns an exact
protocol/port pair, clients declare `supported_proxy_types`, and the Agent
requires the same port to appear in the separate `--allow-tcp-ports` or
`--allow-udp-ports` trust argument. A legacy client that omits the capability
field receives UDP as `enabled=false`. Updated clients request one full sync on
their first post-upgrade start, replacing any cached compatibility-disabled UDP
record before persisting the new sync-capability marker.

RTSP is covered only as an application carried by general TCP, for example
public `10554` to local `554` with
`ffplay -rtsp_transport tcp rtsp://PUBLIC_HOST:10554/path`. Native RTP/RTCP over
UDP requires fixed media ports and one mapping per port; dynamic media ports
are not guaranteed. Raw IP, ICMP, broadcast, multicast, STCP, XTCP, SUDP,
visitors, and arbitrary plugins remain outside the managed whitelist.

The managed L4 gate is reproducible with release artifacts:

```sh
CONTROL_IMAGE=<digest> \
GATEWAY_IMAGE=<digest> \
FRPS_IMAGE=<digest> \
RC_VERSION=X.Y.Z-rc.N \
tests/run-release-smoke.sh
```

It explicitly syncs `supported_proxy_types: [http, tcp, udp]`, renders all
three proxy types, and starts the Agent with separate TCP ports `11000,11002`
and UDP port `11001`. Local validation covered Python compilation, shell
syntax, Compose rendering with placeholder digests, direct TCP/UDP/RTSP helper
round trips, and denial helpers. A complete local Docker run still requires
real immutable RC image digests and the matching Linux client package.
