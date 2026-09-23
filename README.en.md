<img src="control-center/public/HomeTunnel.svg" alt="" width="64" height="64">

# Home Tunnel Server

**Control plane, access policies and tunnel server**

[![Stable 8.0.0](https://img.shields.io/badge/stable-8.0.0-176653)](https://github.com/ZHanry/home-tunnel-server/releases/tag/v8.0.0) [![License Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

[简体中文](README.md) · [Website](https://zhanry.github.io/home-tunnel/en/) · [Downloads](https://github.com/ZHanry/home-tunnel/blob/main/docs/DOWNLOADS.md) · [Quick start](https://github.com/ZHanry/home-tunnel/blob/main/docs/GETTING_STARTED.md)


Deploy the Web console, API, traffic gateway, FRPS and Caddy on your own public
Linux host. The [client repository](https://github.com/ZHanry/home-tunnel-client)
owns desktop/CLI tunnel execution.

## Deploy 8.0.0

Use Linux amd64/arm64, your domain and Docker Compose v2; start with a 2 GiB memory
budget. Verify the release archive's SHA-256, extract it, then run:

```sh
python3 deploy/scripts/setup-wizard.py --write
python3 deploy/scripts/preflight.py
docker compose -f compose.yaml -f compose.release.yaml up -d
```

The wizard asks for your actual DNS, public host and ACME email and refuses to
overwrite existing secrets. Change the bootstrap administrator password at first
login. [Detailed deployment](docs/SELF_HOSTING.md) · [Upgrade](docs/UPGRADING.md).

HTTP/HTTPS and controlled TCP/UDP pools; user/device isolation, traffic policies,
HTTP access protection, TOTP/recovery codes, session revocation, one-time enrollment,
paginated catalogs, tags/favorites and per-item batch operations. 8.0 adds an
opt-in remote-desktop control plane, explicit endpoint pairing and authorization,
and browser viewing over direct UDP. See the [release notes](docs/RELEASE_NOTES.md)
for platform capabilities and unverified paths.

[Account security](docs/ACCOUNT_SECURITY.md) · [Encrypted backup and recovery](docs/disaster-recovery.md) · [Monitoring](docs/MONITORING.md) · [NAS/preflight](docs/NAS.md) · [API/OpenAPI](docs/API.md)

The release stack is server/Web, client/Agent and Android **8.0.0**. The 7.0 tunnel
interface remains compatible; remote desktop requires matching 8.0 implementations.
FRP remains independently versioned at 0.70.1. CI validates service
tests, browser flows, deployment, API responses, recovery and security. Release
assets retain image digests, checksums and integration evidence. Image SBOMs and
build provenance are stored as attestations on the pinned GHCR image digests;
see the [verification guide](docs/RELEASING.md).
