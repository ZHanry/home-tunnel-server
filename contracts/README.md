# API contract ownership

The server owns the API contracts. Version **1.3.0** adds remote-access
authorization modes under `/api/v1/rd`. Publish an immutable `api-v1.3.0`
tag from a clean, reviewed server commit before consumers update their locks.
Keep `api-v1.2.0` and all earlier tags immutable.
`openapi.v1.json` covers REST requests/responses; `api.schema.json` contains the
shared JSON Schema types. `home-tunnel.v1.json` remains byte-identical to the
historical `api-v1.0.0` sync/realtime fixture.

Edit `scripts/generate-api-spec.py`, regenerate and run `--check` plus the real
service integration tests. Consumers update all snapshots and SHA-256 locks
together after review. Never move an existing contract or release tag.
The contract freeze and later product release can use different commits when
only release evidence or actual client download baselines change afterward.
See [API semantics and compatibility](../docs/API.md).
