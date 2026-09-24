# Home Tunnel API 1.3 / 9.0.0

[OpenAPI 3.1](../contracts/openapi.v1.json) · [JSON Schema 2020-12](../contracts/api.schema.json) · [Capabilities](../control-center/src/api-capabilities.ts)

`GET /api/v1/public/capabilities` returns the server version, contract version,
minimum client versions, features and limits. The deployment serves the documents
at `/openapi.json` and `/api-schema.json`. The spec covers 131 REST operations,
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
restricted to one device for management operations, even when its owner is an
administrator. `GET /client/remote-devices` is the sole read-only exception: it
returns minimal IDs, names and presence for devices owned by the same account,
so a desktop session can launch remote control. It cannot list another account
or modify a peer device; `/client/devices` remains device-scoped. Internal
hooks require private networking and, where specified, `x-home-tunnel-key`.
Never publish the control-center, gateway, metrics or FRPS plugin ports directly.

## Remote access modes

All three cross-account modes require authenticated controller and host endpoints
on the same server. The host creates a stable nine-digit ID with
`POST /api/v1/rd/access-profile`; the ID is not a credential. A controller may
send a two-minute request with `POST /api/v1/rd/access/requests`. The host lists
requests, decides locally with `POST /api/v1/rd/access/requests/{id}/decision`,
persists the authorization, then calls `/activate`. Only then does the
controller's `GET` return the target.

For automatic connection to the signed-in desktop, the host sets a fixed
password with `PUT /api/v1/rd/access-profile/password`. The server stores only
an Argon2id hash. Any account on this server with the ID and password may call
`POST /api/v1/rd/access/fixed/redeem`; no trusted-device prebinding is required.
Five failures lock the ID for five minutes, and rate limits also apply. Each
success creates a five-minute, single-pairing invitation. Rotation or `DELETE`
revokes prior fixed-password invitations and sessions; the host checks the
password revision before auto-approving a pairing. This does not imply support
for the Windows lock screen, login screen or UAC secure desktop, which still
needs the separately verified high-privilege service.

### Temporary password

The host's DPoP identity creates a temporary invitation with
`POST /api/v1/rd/assist-invites`. The response returns a nine-digit device code
and a 12-character password once; only a salted hash is stored. Both expire
after five minutes. A controller authenticated to the same server redeems with
`POST /api/v1/rd/assist-invites/redeem`; five wrong attempts revoke the code,
and a successful redemption consumes it. The host can revoke with
`DELETE /api/v1/rd/assist-invites/{id}`. Disabling or revoking the host also
revokes invitations. `GET /api/v1/rd/assist-invites` lists active or redeemed
invitations without revealing passwords, so the host can revoke them after an
app restart. A cross-account controller must send the redeemed `invite_id` in
`POST /api/v1/rd/pairings`; the signed transcript binds both account identities,
endpoint keys, the invitation and a one-session request. The host approves the
exact permissions locally. Standard screen, keyboard, pointer, text input and
text clipboard scopes may be auto-approved for a locally issued invitation;
files and audio require explicit support and selection. Only that pairing can create a session, and invite
revocation closes it immediately. Same-account endpoint queries remain isolated.

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

The 9.0.0 combination is server/Web, desktop/CLI, Android and managed Agent.
Existing tunnel management retains 7.0 compatibility; remote desktop requires
negotiated capabilities and matching 9.0.0 components. Remote desktop remains
disabled by default and has platform limitations described in the release notes.
There is no promised lifetime for obsolete versions.

The immutable contract tag is `api-v1.3.0`; historical tags remain unchanged.
Consumers vendor all three files with SHA-256 locks tied to its reviewed commit.

```sh
python3 scripts/generate-api-spec.py --check
pnpm --dir control-center run build
pnpm --dir control-center test
```

CI requires route/spec parity and validates real authentication, transport,
recovery, metadata and integration responses against the spec with Ajv. Go and
Android consumers also test wire payloads and validate their vendored locks.
An unchanged lock alone is not evidence of runtime compatibility.
