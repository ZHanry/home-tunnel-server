# API contract ownership

The server owns the API contracts. Version **1.5.0** is frozen in source for
the 10.1.0 candidate. It adds a scoped, one-time native remote sign-in handoff,
source-device safeguards and current-device rename under `/api/v1`. Existing
1.4 operations and required fields are retained; remote wire registries and
authorization/test vectors are unchanged. Android 10.0.0 retains its 1.4 lock.

After the reviewed clean server commit passes its checks, publish the immutable
`api-v1.5.0` tag on that exact commit, then consumers import from the verified
tag and update all locks together. A source freeze does not assert that the tag
or product Release already exists. Never move it. The immutable `api-v1.4.0`
tag and every earlier tag stay unchanged. Source verification does not replace
final-artifact runtime acceptance.
`openapi.v1.json` covers REST requests/responses; `api.schema.json` contains the
shared JSON Schema types. `home-tunnel.v1.json` remains byte-identical to the
historical `api-v1.0.0` sync/realtime fixture.

Edit `scripts/generate-api-spec.py`, regenerate and run `--check` plus the real
service integration tests. Consumers update all snapshots and SHA-256 locks
together after review. Never move an existing contract or release tag.
The contract freeze and later product release can use different commits when
only release evidence or actual client download baselines change afterward.
See [API semantics and compatibility](../docs/API.md).
