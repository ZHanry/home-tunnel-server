# API contract ownership

The server owns API contract **1.1.0**, published at immutable tag `api-v1.1.0`.
`openapi.v1.json` covers REST requests/responses; `api.schema.json` contains the
shared JSON Schema types. `home-tunnel.v1.json` remains byte-identical to the
historical `api-v1.0.0` sync/realtime fixture.

Edit `scripts/generate-api-spec.py`, regenerate and run `--check` plus the real
service integration tests. Consumers update all snapshots and SHA-256 locks
together after review. Never move an existing contract or release tag.
See [API semantics and compatibility](../docs/API.md).
