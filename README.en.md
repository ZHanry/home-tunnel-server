# Home Tunnel Server / HomeDesk

The current main line is **11.0.0-rc.1**, integrating the Hearth Web console and native HomeDesk device directory. HTTP/HTTPS and governed TCP/UDP tunneling remain available. Remote desktop requires authenticated, encrypted direct P2P; failure terminates the connection. The server adds hbbs signaling only, with no hbbr/TURN or media forwarding.

[简体中文](README.md) · [Candidate release](https://github.com/ZHanry/home-tunnel-server/releases/tag/v11.0.0-rc.1) · [Last stable 10.1.0](https://github.com/ZHanry/home-tunnel-server/releases/tag/v10.1.0)

Deploy on public Linux amd64/arm64 with DNS and Docker Compose v2. Node/SQLite, FRPS, the traffic gateway and Caddy remain. The additional hbbs process has a 64 MiB memory limit; total deployment capacity still needs measurement.

```sh
python3 deploy/scripts/setup-wizard.py --write
python3 deploy/scripts/preflight.py
docker compose -f compose.yaml -f compose.release.yaml up -d
```

Verify the archive checksum first; change the bootstrap password at first login. Configure the same hbbs address and public key on the server and both peers. [Deployment, identity backup and upgrade](docs/HOMEDESK.md). API `api-v1.6.0` stays additive on `/api/v1`. Historical browser remote desktop and RD/TURN/STUN overlays are retired from production in 11.x.

Permissions, ACLs, quotas, traffic policies, diagnostics, MFA, revocation, enrollment and batch operations remain. Independent CLI/NAS Agents continue without the GUI. The Web directory launches `homedesk://ID`; authentication stays in the native app. Recent registration does not prove a media connection.

Cross-network NAT, sustained media and physical Android acceptance remain pending. Restricted networks can fail direct connectivity; this candidate has no relay fallback. [Candidate release notes](docs/HOMEDESK_RELEASE.md). Historical acceptance records apply only to their own versions.

Node 24.19.0, FRP 0.70.1 and digest-pinned hbbs 1.1.16. Releases contain three attachments: deployment archive, source/evidence materials and SHA256SUMS. Image SBOMs and provenance stay attached to immutable GHCR digests.

[API](contracts/openapi.v1.json) · [Recovery](docs/disaster-recovery.md) · [Account security](docs/ACCOUNT_SECURITY.md) · [Monitoring](docs/MONITORING.md) · [Apache-2.0](LICENSE)
