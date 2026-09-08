# Repository migration

This component was extracted from `ZHanry/home-tunnel` at `cdf6136593d3dd7863f704724746a92a30240123`.
Path filtering retained commits relevant to this repository and their authorship;
filtered commit IDs differ from upstream. The original repository, tags, releases,
issues and Pages URL remain available. No deployed database, device identity,
credential format, REST endpoint or WebSocket event changes as part of the split.

The other code repositories are `home-tunnel-server`, `home-tunnel-client` and
`home-tunnel-android`. GUI and CLI share one Go core in the client repository.
The server owns the versioned protocol fixture. Consumers vendor that fixture
with a checksum and an immutable source ref in `contracts/lock.json`, so ordinary
builds do not need another repository checkout or a live server.

Published 5.0.0 artifacts remain in the original repository. Component repositories
start independent releases after that baseline; do not move or recreate old upstream
tags with new binaries. The hub's client-release mirror preserves the legacy updater
entry point when a new stable client is released.
