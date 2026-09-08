<div align="center">
  <img src="docs/assets/HomeTunnel.svg" alt="Home Tunnel" width="80" height="80">
  <h1>Home Tunnel Server</h1>
  <p><strong>控制中心、Web 管理后台与自托管隧道服务</strong></p>
  <p>
    <img src="https://img.shields.io/badge/status-internal_testing-92400e" alt="Status: internal testing">
    <a href="https://github.com/ZHanry/home-tunnel-server/actions/workflows/ci.yml"><img src="https://github.com/ZHanry/home-tunnel-server/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache-2.0 license"></a>
  </p>
  <p><a href="README.en.md">English</a> · <a href="https://zhanry.github.io/home-tunnel/">项目网站</a></p>
</div>

本仓库负责 Home Tunnel 的公网服务端：管理用户、设备和连接，通过 Caddy、流量网关与 FRPS 将请求转发到家中的电脑或 NAS。

> **内部测试阶段。** 建议使用独立测试环境与测试数据。当前目标是验证功能、权限、网络行为和部署流程，尚无生产稳定性承诺。

[项目总览](https://github.com/ZHanry/home-tunnel) · [GUI / CLI 客户端](https://github.com/ZHanry/home-tunnel-client) · [Android App](https://github.com/ZHanry/home-tunnel-android)

## 服务组成

| 组件 | 职责 |
| --- | --- |
| 控制中心 | REST / WebSocket API、账号、设备注册、连接策略、短期授权、Web 控制台 |
| 流量网关 | HTTP 访问控制、反向代理、速率限制与流量采样 |
| Caddy | 公网 HTTP / HTTPS 入口与证书处理 |
| FRPS | 受管隧道接入与明确分配的 TCP / UDP 端口 |
| SQLite | 控制状态与持久化数据 |

服务端通过 API 与客户端通信，构建时不需要客户端或 Android 源码。

## 从源码启动测试环境

准备一台具有公网地址的 **Linux amd64 / arm64 主机**，安装 Docker Engine 与 Docker Compose。配置控制台域名及隧道通配符 DNS；HTTP 验证场景需要公网 TCP 80、443 和客户端可达的 FRPS 端口（默认 7000）。

```sh
git clone https://github.com/ZHanry/home-tunnel-server.git
cd home-tunnel-server

# 将以下域名、IP 和邮箱替换成自己的测试环境信息。
sh deploy/scripts/new-selfhost-config.sh   tunnel.example.com 203.0.113.10   console.tunnel.example.com admin@example.com

docker compose -f compose.yaml -f compose.build.yaml config --quiet
docker compose -f compose.yaml -f compose.build.yaml up -d --build
docker compose ps

# 获取一次性管理员密码。
cat deploy/secrets/bootstrap_admin_password
```

访问配置的控制台地址，例如 `https://console.tunnel.example.com/admin`，登录后修改初始密码，再创建测试账号。配置脚本会生成 `.env` 与本地密钥；这些文件保留在测试主机，不提交到 Git。

以上命令使用源码构建覆盖配置，适合当前开发阶段。DNS、端口、证书、日志和备份步骤见 [自托管测试指南](docs/SELF_HOSTING.md)。

## 第一次联调

1. 在家中的电脑或 NAS 构建并安装[统一客户端](https://github.com/ZHanry/home-tunnel-client#readme)。
2. 使用控制台创建的账号登录客户端，完成设备注册。
3. 在 Web 控制台为该设备创建一个 HTTP 测试连接，填写目标服务地址和端口。
4. 从另一网络访问公网地址，再验证暂停、恢复、退出客户端和重新连接。

Android 用于管理已经注册的设备与连接。TCP / UDP 需要管理员明确分配公网端口，建议在 HTTP 流程验证完成后单独测试。

## 协议范围

| 类型 | 示例 | 策略路径 |
| --- | --- | --- |
| HTTP / HTTPS | NAS Web、相册、Home Assistant | Caddy → 网关 → FRPS |
| TCP | SSH、RDP、RTSP-over-TCP | 公网分配端口 → FRPS |
| 固定端口 UDP | 已知固定端口的应用服务 | 公网分配端口 → FRPS |

TCP / UDP 不经过 HTTP 网关，不能套用网关的 Basic Auth、HTTP 限速和流量配额。当前不提供 raw IP、ICMP、广播、组播或任意 FRP 插件能力。详见 [安全模型](docs/SECURITY_MODEL.md)。

## 开发与检查

源码开发使用 **Node.js 24.19.0、pnpm 11**；完整服务联调使用 Docker Compose。

```sh
cd control-center
pnpm install --frozen-lockfile
pnpm run check
pnpm run lint
pnpm run build
pnpm test

cd ../traffic-gateway
pnpm install --frozen-lockfile
pnpm run check
pnpm run build
pnpm test
```

Web 交互测试、覆盖率和部署检查见 [贡献指南](CONTRIBUTING.md)。CI 状态反映当前提交的自动化检查结果。

## 目录与文档

| 路径 | 内容 |
| --- | --- |
| `control-center/` | API、Web 界面和控制业务 |
| `traffic-gateway/` | HTTP 网关 |
| `deploy/` | 服务配置、部署、备份和诊断工具 |
| `contracts/` | API v1 协议夹具 |
| `tests/` | Compose 和跨组件集成验证 |
| `docs/` | 架构、部署、安全与测试发布指南 |

![Web 管理后台开发预览，使用测试数据](docs/assets/dashboard.jpg)

[架构](docs/ARCHITECTURE.md) · [测试部署](docs/SELF_HOSTING.md) · [测试发布](docs/RELEASING.md) · [安全报告](SECURITY.md) · [Apache-2.0](LICENSE)
