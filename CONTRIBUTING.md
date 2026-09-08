# Contributing

The public server stack: API, web console, gateway and deployment.

This repository owns its code, tests and component releases. The project overview,
downloads and cross-component roadmap live at https://github.com/ZHanry/home-tunnel.

## Local checks

```sh
cd control-center
pnpm install --frozen-lockfile
pnpm run check && pnpm run lint && pnpm run build && pnpm test
cd ../traffic-gateway
pnpm install --frozen-lockfile
pnpm run check && pnpm run build && pnpm test
```

Keep changes focused, update the relevant tests and documentation, and explain
changes to authentication, leases, Agent validation, signing or update trust.
Generated binaries, credentials and local configuration must remain untracked.
Pull requests never receive release signing secrets.

## Versions and compatibility

Only this component's version is changed for a component release. API v1 is the
initial compatibility boundary; see `compatibility.json` and `docs/RELEASING.md`.
The original project history remains available under the upstream `v5.0.0` tag.
