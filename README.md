# Home Tunnel Server

Home Tunnel 的服务端仓库：控制中心、Web 管理后台、流量网关，以及 Caddy / FRPS 的自托管部署配置。

[项目主页](https://github.com/ZHanry/home-tunnel) · [统一客户端 GUI / CLI](https://github.com/ZHanry/home-tunnel-client) · [Android 管理 App](https://github.com/ZHanry/home-tunnel-android) · [English](README.en.md)

## 部署

需要有公网地址的 Linux 服务器、域名和 DNS 配置。支持 Linux amd64 / arm64。

```sh
git clone https://github.com/ZHanry/home-tunnel-server.git
cd home-tunnel-server
sh deploy/scripts/new-selfhost-config.sh tunnel.example.com 203.0.113.10 console.tunnel.example.com admin@example.com
docker compose config --quiet
docker compose pull
docker compose up -d
cat deploy/secrets/bootstrap_admin_password
```

访问 `https://console.tunnel.example.com/admin`，使用一次性管理员密码登录后立即改密。
完整 DNS、TLS、防火墙、升级、备份和回滚说明见 [自托管指南](docs/SELF_HOSTING.md)。
迁移保留已发布 5.0.0 的镜像地址和部署默认值，现有部署无需因拆仓重新安装。

## 目录职责

| 目录 | 内容 |
| --- | --- |
| `control-center/` | REST / WebSocket API、管理后台、设备与连接策略、FRPS 授权 |
| `traffic-gateway/` | HTTP 访问控制、反向代理、限速和流量采样 |
| `deploy/` | Caddy、FRPS、部署、备份和回滚工具 |
| `contracts/` | 服务端维护的 API v1 协议夹具与版本说明 |
| `tests/` | 部署、Compose 和使用已发布客户端的集成验证 |

服务端通过 API 协议与客户端交互，不需要克隆客户端源码来构建。
新组件版本独立发布；已验证的共同基线为服务端 / 客户端 / Android 5.0.0、API v1。
兼容性记录见 [compatibility.json](compatibility.json)，源码检查见 [贡献指南](CONTRIBUTING.md)，发布见 [发布说明](docs/RELEASING.md)。

## 迁移来源

从 [原项目 5.0.0](https://github.com/ZHanry/home-tunnel/releases/tag/v5.0.0) 提取，保留服务端相关提交历史。
现有账号、数据库、设备凭据和 API 路径保持兼容。原仓库继续作为文档和下载入口。

Apache-2.0，见 [LICENSE](LICENSE)。
