# API contract ownership

The server owns the API contracts. Version **1.4.0** is frozen for 10.0.0.
It adds discovered native capabilities, display DPI, four access modes,
actionable session failures, and agent-reported tunnel diagnostics under
`/api/v1`. Publish the immutable `api-v1.4.0` tag on the reviewed server commit
that carries `contract_status: frozen`, then consumers import from that tag and
update their locks. Never move it. The immutable `api-v1.3.0` tag and every
earlier tag stay unchanged.
`openapi.v1.json` covers REST requests/responses; `api.schema.json` contains the
shared JSON Schema types. `home-tunnel.v1.json` remains byte-identical to the
historical `api-v1.0.0` sync/realtime fixture.

Edit `scripts/generate-api-spec.py`, regenerate and run `--check` plus the real
service integration tests. Consumers update all snapshots and SHA-256 locks
together after review. Never move an existing contract or release tag.
The contract freeze and later product release can use different commits when
only release evidence or actual client download baselines change afterward.
See [API semantics and compatibility](../docs/API.md).
