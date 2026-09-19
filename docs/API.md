# Home Tunnel API 1.1 / 7.0.0

[OpenAPI 3.1](../contracts/openapi.v1.json) · [JSON Schema 2020-12](../contracts/api.schema.json) · [Capabilities](../control-center/src/api-capabilities.ts)

`GET /api/v1/public/capabilities` returns the server version, contract version,
minimum client versions, features and limits. The deployment serves the documents
at `/openapi.json` and `/api-schema.json`. The spec covers 82 REST operations,
including readiness and private hooks. It does not model HTML/download redirects
as JSON APIs. WebSocket and FRP sync envelopes remain in `home-tunnel.v1.json`.

## Authentication and scope

Use your deployment's HTTPS origin. Web login sets HttpOnly, SameSite=Strict
cookies; JSON contains a CSRF token but no bearer tokens. Mutations send
`x-csrf-token`. `GET /auth/session` (under `/api/v1`) recovers the current CSRF
token without rotating the session. Native clients send `Authorization: Bearer`.
Never send tokens to an origin learned from an untrusted redirect.

Web refresh uses Web Locks and BroadcastChannel. A lost response may be retried
within a fixed 30-second window only from the same IP and user agent. Native
refresh remains strictly single-use. Replays outside the allowed Web retry
window revoke the session. Do not retry an MFA verification automatically:
authenticator counters and recovery codes are consumed once.

Web/Android management sessions operate on account-owned resources; only the
deployment administrator can use `/admin`. Enrolled desktop/CLI sessions are
restricted to one device, even when its owner is an administrator. Internal
hooks require private networking and, where specified, `x-home-tunnel-key`.
Never publish the control-center, gateway, metrics or FRPS plugin ports directly.

## Pagination, capabilities and conflicts

Devices and connections use `page` and `page_size` (1–100); responses include
`items`, `page`, `page_size`, `total`, `total_pages`. Search is bounded to 120
characters. Consumers must read all relevant pages and retain returned
capabilities. TCP/UDP visibility depends on deployment pools and account rights,
not just a client version. Server-side limits are 1,000 active devices and 1,000
connections per account, 250 connections per device, 50 items per batch and 12
tags per device. Quotas fail explicitly; nothing is silently truncated.

Connection writes use `expected_version` or `If-Match`. An `access` patch also
requires `expected_access_policy_version`. ACL-only changes advance the ACL
version without restarting the Agent. A 409 returns current versions; keep the
draft and ask the operator to reconcile it. Metadata uses
`expected_metadata_version`. Transport settings use `transport_settings_version`.
Batch operations return one status per item and can partially succeed.

## Version policy and validation

The supported combination is server/Web, desktop/CLI, Android and managed Agent
**7.0.0**. 6.x clients are not supported against 7.0's paginated catalogs and
security flows. Upgrade together; a 6.x client may otherwise show only the first
page. The stable 7.0 line receives compatible fixes; breaking behavior requires
a new major product version. There is no promised lifetime for obsolete versions.

The immutable contract tag is `api-v1.1.0`. `api-v1.0.0` and historical releases
remain unchanged. Consumers vendor all three files with SHA-256 locks.

```sh
python3 scripts/generate-api-spec.py --check
pnpm --dir control-center run build
pnpm --dir control-center test
```

CI requires route/spec parity and validates real authentication, transport,
recovery, metadata and integration responses against the spec with Ajv. Go and
Android consumers also test wire payloads and validate their vendored locks.
An unchanged lock alone is not evidence of runtime compatibility.
