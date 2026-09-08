# Security repair notes

The 5.0.1 internal test build addresses the open control-center findings and updates
the actual FRPS build dependencies. The published FRPS `0.70.1-r3` dependency is
recorded with its signed manifest in `deploy/frps/`.

| Area | Repair |
| --- | --- |
| Authorization header | Bounded, linear Bearer parsing replaces overlapping regex quantifiers |
| Public/API request work | Separate IP budgets, applied before API body parsing and session lookup |
| Sensitive routes | Explicit password-change and DNS-verification request limits |
| Development preview | Rate limiting on the local preview application |
| URL comparisons | Hostnames are parsed and compared exactly in notification tests |
| NTLM | `github.com/Azure/go-ntlmssp v0.1.1`, GHSA-pjcq-xvwq-hhpj |
| SSH | `golang.org/x/crypto v0.56.0`, GO-2026-6355, GO-2026-6354 and GO-2026-6303 |
| WebSocket dependency | `github.com/gorilla/websocket v1.5.3`, GHSA-w67g-5rqw-f597 |

The dependency locks are copied into the verified upstream FRP source during Docker
builds. Audits use the same locks; a source-only version bump is not sufficient.
The discontinued OpenPGP package reported at crypto-module level is not imported or
linked, and builds reject that package in the dependency graph.

CodeQL workflows now inspect remaining open findings after an analysis upload.
Regression tests cover request budgets and malformed authorization headers; the
component still runs its service, browser, integration and package checks.
