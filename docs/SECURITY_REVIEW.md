# Security repair notes

NestLink 14.0.0 retains the request-protection repairs below and updates the
actual Node and FRPS dependency locks. The reviewed FRPS `0.70.1-r4` image and
its original signed dependency manifest are pinned in `deploy/frps/`.

| Area | Repair |
| --- | --- |
| Authorization header | Bounded, linear Bearer parsing replaces overlapping regex quantifiers |
| Public/API request work | Separate IP budgets, applied before API body parsing and session lookup |
| Sensitive routes | Explicit password-change and DNS-verification request limits |
| Development preview | Rate limiting on the local preview application |
| URL comparisons | Hostnames are parsed and compared exactly in notification tests |
| Node tooling | `brace-expansion 5.0.12` in both locks; development `yaml 2.8.3` fixes GHSA-48c2-rrv3-qjmp |
| Go build toolchain | `1.27.2` includes the current standard-library fixes |
| NTLM | `github.com/Azure/go-ntlmssp v0.1.1`, GHSA-pjcq-xvwq-hhpj |
| SSH | `golang.org/x/crypto v0.57.0` retains fixes for GO-2026-6355, GO-2026-6354 and GO-2026-6303 |
| HTTP/2 | `golang.org/x/net v0.60.0`, GO-2026-6603, GO-2026-6610, GO-2026-6611, GO-2026-6612 and GO-2026-6617 |
| WebSocket dependency | `github.com/gorilla/websocket v1.5.3`, GHSA-w67g-5rqw-f597 |

The dependency locks are copied into the verified upstream FRP source during
Docker builds. Audits use the same locks, and the checker requires all four
reviewed security module pins. Minimal-version selection also updates the
required sync, sys, text and tools modules; the lock records the actual graph.
The discontinued OpenPGP package behind module-only GO-2026-5932 is not imported
or linked. Builds reject it in the dependency graph, and the reviewed FRPS scan
reports zero vulnerable imported packages or reachable symbols.

Protected [FRPS run 38052783144](https://github.com/ZHanry/home-tunnel-server/actions/runs/38052783144)
built, signed and attested the real amd64/arm64 r4 image. Independent verification
checks the image and manifest signatures, source revision, GitHub attestations,
immutable tag and original artifact ZIP digest. Both Node projects pass frozen
lockfile installs, full and production dependency audits with zero advisories,
and type, lint and formatting checks. The original UI captures remain unchanged;
their manifest records the Node tooling overlay validation separately.

CodeQL workflows inspect remaining open findings after an analysis upload.
Regression tests cover request budgets and malformed authorization headers;
application release automation retains its service, browser, integration and
package checks. Dependency review does not replace exact-version application
acceptance or deployment validation.
