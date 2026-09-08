# API contract ownership

The server repository is the source of truth for `home-tunnel.v1.json`. The initial
immutable protocol tag is `api-v1.0.0`, independent of server application versions.
This fixture records reserved names, sync fields and realtime envelopes; it is not a
complete OpenAPI schema. Runtime compatibility also requires integration testing.

Consumers vendor the exact fixture with its SHA-256 and source tag in `contracts/lock.json`.
To change it, first review and test backward compatibility, publish a new immutable
`api-vX.Y.Z` tag, then update each consumer's fixture and lock together. Do not move tags.
