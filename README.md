<div align="center">
  <img src="docs/assets/HomeTunnel.svg" alt="Home Tunnel" width="72" height="72">
  <h1>Home Tunnel Server</h1>
  <p><strong>管理账号、设备和服务连接的控制中心</strong></p>
  <p><a href="https://github.com/ZHanry/home-tunnel-server/releases/latest"><img src="https://img.shields.io/badge/release-6.2.0-176653" alt="Release 6.2.0"></a> <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache-2.0"></a></p>
  <p><a href="README.en.md">English</a> · <a href="https://zhanry.github.io/home-tunnel/">项目网站</a></p>
</div>

6.2.0 新增「系统设置 → 端口与协议」：管理员可在已预留的端口池内开关 TCP/UDP、调整可分配范围并查看用量，保存后立即应用。普通用户自助创建仍需单独授权。

6.0 正式版重做 Web 控制台，采用顶部导航、设备卡片和按任务组织的管理页面。此仓库包含控制中心、流量网关与 Caddy / FRPS 部署配置。

## 安装与升级

从 [Release](https://github.com/ZHanry/home-tunnel-server/releases/latest) 下载 `home-tunnel-server-6.2.0.tar.gz`，按[自托管指南](docs/SELF_HOSTING.md)生成配置并启动。运行目标为 Linux amd64 / arm64，需要 Docker Compose、域名及公网主机。

已有部署先阅读[升级说明](docs/UPGRADING.md)。6.0 会自动将旧数据库中的额外管理员转为普通用户，保留账号和资源；最早创建的有效管理员保留管理权限。升级前备份数据库与配置。

## 主要功能

- 总览真实连接状态、设备状态和 Web 流量；系统组件异常会明确提示。
- 一名管理员管理部署，普通用户只管理账号名下的资源。
- 删除普通用户时撤销全部会话与设备凭据，停止并移除连接；保留历史审计和流量记录。
- 登记到设备的会话受本机边界限制，连接读写、域名、流量和实时通知遵循同一规则。
- HTTP / HTTPS、通用 TCP、固定端口 UDP，支持自定义域名、访问保护、配额、带宽限制和备份。

![6.0 控制台](docs/assets/dashboard.jpg)

## 开发

控制中心使用 Node.js 24.19+ 与 TypeScript，数据保存在 SQLite。运行 `pnpm install --frozen-lockfile`、`pnpm build`、`pnpm test` 和 `pnpm test:browser`。网关位于 `traffic-gateway/`；协议约定在 `contracts/`。

[架构](docs/ARCHITECTURE.md) · [安全模型](docs/SECURITY_MODEL.md) · [发布流程](docs/RELEASING.md) · [版本说明](docs/RELEASE_NOTES.md) · [项目入口](https://github.com/ZHanry/home-tunnel)
