<img src="control-center/public/HomeTunnel.svg" alt="" width="64" height="64">

# Home Tunnel Server

**控制台、权限与隧道服务端**

[![Stable 7.0.0](https://img.shields.io/badge/stable-7.0.0-176653)](https://github.com/ZHanry/home-tunnel-server/releases/tag/v7.0.0) [![License Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

[English](README.en.md) · [项目网站](https://zhanry.github.io/home-tunnel/) · [下载](https://github.com/ZHanry/home-tunnel/blob/main/docs/DOWNLOADS.md) · [快速开始](https://github.com/ZHanry/home-tunnel/blob/main/docs/GETTING_STARTED.md)


在自己的公网 Linux 主机上部署 Web 控制台、API、流量网关、FRPS 和 Caddy，
为家庭服务提供访问入口。本仓库负责控制面与部署；隧道执行端见 [Client](https://github.com/ZHanry/home-tunnel-client)。

## 部署 7.0.0

需要公网 Linux amd64/arm64、域名、Docker Compose v2；起步建议 2 GiB 内存。
从 [Release](https://github.com/ZHanry/home-tunnel-server/releases/tag/v7.0.0) 下载部署包并核验 SHA256SUMS，进入解压目录：

```sh
python3 deploy/scripts/setup-wizard.py --write
python3 deploy/scripts/preflight.py
docker compose -f compose.yaml -f compose.release.yaml up -d
```

向导会询问域名、公网地址和 ACME 邮箱，拒绝覆盖已有秘密。
首次登录必须改密。完整 DNS、端口、镜像与升级步骤见 [部署指南](docs/SELF_HOSTING.md)。

## 能力

HTTP/HTTPS、受控 TCP/UDP 端口池、SSH/RDP/RTSP 预设；用户/设备隔离、流量限制、
HTTP 白名单和 Basic Auth；TOTP/恢复码、会话撤销、短期接入码；分页搜索、标签收藏和
最多 50 项批量操作。7.0 修复多标签页会话、访问策略并发覆盖和备份健康状态。

| 运维任务 | 文档 |
| --- | --- |
| 新部署 / NAS / 应用示例 | [部署](docs/SELF_HOSTING.md) · [向导与 NAS](docs/NAS.md) |
| 6.x 升级、回退边界 | [升级 7.0.0](docs/UPGRADING.md) |
| TOTP、接入码与会话 | [账号安全](docs/ACCOUNT_SECURITY.md) |
| 管理员找回、异机备份、恢复演练 | [灾难恢复](docs/disaster-recovery.md) |
| Grafana、证书与备份告警 | [监控](docs/MONITORING.md) |
| 开发、字段和兼容性 | [API](docs/API.md) · [OpenAPI](contracts/openapi.v1.json) |

支持组合为 Server/Web、Client/Agent、Android **7.0.0**；6.x 客户端不在该组合中。
FRP 0.70.1 独立版本及已固定的安全依赖不受产品版本号变更影响。

## 开发与质量

```sh
pnpm --dir control-center install --frozen-lockfile
pnpm --dir control-center run build
pnpm --dir control-center test
python3 scripts/generate-api-spec.py --check
```

Node 24.19.0；traffic-gateway 使用相同命令单独检查。CI 包含浏览器回归、
部署验证、契约响应校验、恢复测试和安全扫描。Release 保留镜像摘要、SBOM/证明与
校验清单；发布需先通过主分支质量门禁。

[项目入口](https://github.com/ZHanry/home-tunnel) · [贡献](CONTRIBUTING.md) · [安全报告](SECURITY.md)
