# API contract ownership

The server owns the API contracts. The existing stable **1.1.0** contract is
published at immutable tag `api-v1.1.0`; the 8.0 candidate source generates
**1.2.0**, including additive remote-desktop operations under `/api/v1/rd`.
Freeze the reviewed candidate on main at `api-v1.2.0-rc.1` after its quality and
security checks pass. Consumers must verify that the tag exists, resolve its
actual commit and hash the downloaded snapshot bytes before updating their locks.
`openapi.v1.json` covers REST requests/responses; `api.schema.json` contains the
shared JSON Schema types. `home-tunnel.v1.json` remains byte-identical to the
historical `api-v1.0.0` sync/realtime fixture.

Edit `scripts/generate-api-spec.py`, regenerate and run `--check` plus the real
service integration tests. Consumers update all snapshots and SHA-256 locks
together after review. Never move an existing contract or release tag.
See [API semantics and compatibility](../docs/API.md).
