<div align="center">
  <img src="docs/assets/HomeTunnel.svg" alt="Home Tunnel" width="72" height="72">
  <h1>Home Tunnel Server</h1>
  <p><strong>The control center for accounts, devices and connections</strong></p>
  <p><a href="https://github.com/ZHanry/home-tunnel-server/releases/latest"><img src="https://img.shields.io/badge/release-6.2.0-176653" alt="Release 6.2.0"></a> <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache-2.0"></a></p>
  <p><a href="README.md">简体中文</a> · <a href="https://zhanry.github.io/home-tunnel/">Website</a></p>
</div>

6.1.0 adds bounded automatic TCP/UDP port assignment for clients, with administrator-controlled self-service permission.

The 6.0 release rebuilds the Web console with top navigation, device cards and task-focused management pages. This repository owns the control center, traffic gateway and Caddy / FRPS deployment.

6.2.0 adds **Settings → Ports and protocols**. Administrators can enable TCP/UDP, choose ranges within a prepared server pool, and inspect usage. Changes apply immediately; regular-user creation permission remains separate.

## Install and upgrade

Download `home-tunnel-server-6.2.0.tar.gz` from [Releases](https://github.com/ZHanry/home-tunnel-server/releases/latest), then follow [self-hosting](docs/SELF_HOSTING.md). Linux amd64 / arm64, Docker Compose, a public host and DNS are required.

Read [upgrading](docs/UPGRADING.md) for existing deployments. The migration retains the earliest active administrator and converts additional administrators to ordinary users while preserving accounts and resources. Back up data and configuration first.

## Features

- A new overview of actual service activity, device status and Web traffic, with actionable component health.
- One administrator per deployment. Regular users manage their own resources.
- Account deletion revokes sessions and device credentials and removes connections, preserving historical audit and traffic records.
- Device sessions are restricted to local connections, domains, traffic and realtime events.
- HTTP / HTTPS, general TCP and fixed UDP ports; custom domains, access policies, quotas, bandwidth limits and backups.

![6.0 console](docs/assets/dashboard.jpg)

## Development

The control center uses Node.js 24.19+, TypeScript and SQLite. Run `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm test` and `pnpm test:browser` there. Gateway source is in `traffic-gateway/`; protocol contracts are in `contracts/`.

[Architecture](docs/ARCHITECTURE.md) · [Security](docs/SECURITY_MODEL.md) · [Releasing](docs/RELEASING.md) · [Release notes](docs/RELEASE_NOTES.md) · [Project hub](https://github.com/ZHanry/home-tunnel)
