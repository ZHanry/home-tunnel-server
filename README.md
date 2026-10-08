# Home Tunnel Server / HomeDesk

当前主线为 **11.0.0-rc.2 候选版**，整合暖居 Web 控制台和原生 HomeDesk 远控目录。内网穿透完整保留；远控必须认证、加密并直接连接，连接失败会停止。服务器只增加 hbbs 信令，不运行 hbbr/TURN，也不转发远控画面、声音、输入或文件。

[English](README.en.md) · [候选发行](https://github.com/ZHanry/home-tunnel-server/releases/tag/v11.0.0-rc.2) · [最后稳定版 10.1.0](https://github.com/ZHanry/home-tunnel-server/releases/tag/v10.1.0)

## 部署

需要公网 Linux amd64/arm64、域名、Docker Compose v2。现有 Node/SQLite、FRPS、流量网关和 Caddy 保留，新增 hbbs 限制 64 MiB 内存；这不是整体最低内存或实测容量承诺。

从候选 Release 下载部署包，核验 SHA256SUMS，解压后运行：

```sh
python3 deploy/scripts/setup-wizard.py --write
python3 deploy/scripts/preflight.py
docker compose -f compose.yaml -f compose.release.yaml up -d
```

首次登录必须改密。配置 hbbs 公网地址与公钥后，两端 HomeDesk 使用同一信任配置。实际端口、指纹、身份备份及升级步骤见 [HomeDesk 部署](docs/HOMEDESK.md)。新 API 为冻结的 `api-v1.6.0`，保留 `/api/v1`。旧浏览器远控在 11.x 生产路径退休，不再叠加历史 RD/TURN/STUN overlays。

## 能力与边界

HTTP/HTTPS、受控 TCP/UDP、端口池、用户与设备权限、ACL、配额、流量治理、诊断、TOTP、会话撤销、接入码和批量操作继续使用现有实现。CLI/NAS/background Agent 独立运行，不受 HomeDesk 远控配置或打洞失败影响。

Web 显示本账号已接入的 HomeDesk 设备，并通过 `homedesk://ID` 打开原生客户端。密码、信任配置和认证留在客户端。近期登记只表示目录刷新，不代表已经建立 P2P 远控。

跨网 NAT、长期媒体和 Android 真机验收尚未完成；受限网络可能无法直连，此候选版不会用中继兜底。详见 [候选发行说明](docs/HOMEDESK_RELEASE.md)。旧 10.x 验证材料仅属于对应历史版本。

## 运维与开发

[自托管](docs/SELF_HOSTING.md) · [HomeDesk 升级与密钥备份](docs/HOMEDESK.md) · [数据库与配置恢复](docs/disaster-recovery.md) · [账号安全](docs/ACCOUNT_SECURITY.md) · [监控](docs/MONITORING.md) · [NAS](docs/NAS.md) · [API](contracts/openapi.v1.json)

```sh
pnpm --dir control-center install --frozen-lockfile
pnpm --dir control-center run build
pnpm --dir control-center test
python3 scripts/generate-api-spec.py --check
```

Node 24.19.0，FRP 0.70.1，hbbs 1.1.16 固定镜像摘要。三个公开附件：部署包、包含源码/许可证/镜像证据的材料包、SHA256SUMS。镜像 SBOM 和构建证明保留在 GHCR 不可变摘要上。

[项目入口](https://github.com/ZHanry/home-tunnel) · [Client](https://github.com/ZHanry/home-tunnel-client) · [安全](SECURITY.md) · [Apache-2.0](LICENSE)
