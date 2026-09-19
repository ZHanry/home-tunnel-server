# 部署向导、预检与 NAS

公网控制面推荐运行在受支持的 Linux amd64/arm64 主机上，准备自己的域名、
公网入站能力、Docker Engine 和 Compose v2。起步预算 2 GiB 内存、2 GiB 可用
磁盘；流量、连接规模及监控栈需要额外预算。家中 NAS 运行客户端即可，无需公网 IP。

```sh
python3 deploy/scripts/setup-wizard.py
# 检查预览后，重复并添加 --write 生成 .env 和秘密文件。
python3 deploy/scripts/preflight.py
# 已运行的部署不检测自身占用的入站端口：
python3 deploy/scripts/preflight.py --existing --json
# 使用端口池时：
python3 deploy/scripts/preflight.py -f deploy/compose.ports.yaml
```

向导不覆盖已有配置；预检不执行 `.env` 的 shell 内容，不打印秘密。它检查 HTTPS
同源地址、DNS、端口池范围、所需秘密文件、文件权限、可写目录、磁盘空间、Docker
Linux 引擎、Compose 配置和本地端口冲突。端口检测读取选定 overlay 合并后的配置，
逐个检测 TCP/UDP 发布端口（含端口池），使用对应的 IPv4/IPv6 绑定地址。
`--expected-ip` 可核对 DNS；
`--skip-network` 明确跳过 DNS。预检不能证明云安全组或路由器允许公网入站。

| 家庭环境 | 客户端部署方式 | 限制 |
| --- | --- | --- |
| Synology DSM | Container Manager 导入本地 Compose 项目；SSH 一次性登记 | 需要 amd64/arm64 与 Compose v2，不提供 SPK |
| QNAP | Container Station Compose 应用；SSH 登记 | 不提供 QPKG，检查 CPU 架构和宿主端口 |
| Unraid | Compose Manager 或 Docker CLI，持久状态放受限 appdata | 不冒充 Community Applications 上架项目 |
| 普通 Linux / mini PC | 官方 Linux 客户端和 systemd 服务 | 优先使用普通用户、限制状态文件权限 |

客户端仓库提供[可本地构建的 NAS 模板](https://github.com/ZHanry/home-tunnel-client/tree/main/packaging/nas)，
使用已验证的 Linux 发行包，不引用未发布的客户端镜像。Linux headless 状态文件
使用 0600 权限；宿主机管理员仍能读取凭据。避免公开 NAS 管理界面。

Home Assistant、Immich、Jellyfin 示例见[场景指南](https://github.com/ZHanry/home-tunnel/blob/main/docs/SCENARIOS.md)。
先在客户端主机测试本地目标可达，再创建公网连接。不能让手机替代 NAS 上持续运行的 Agent。

English: the wizard previews before writing, refuses overwrites, and delegates
secret generation to the existing deployment generator. Preflight checks local
configuration, DNS, ports and storage without proving public inbound reachability.
Use supported Compose-capable NAS models with the locally built client template;
the public server stays on your VPS. Native NAS application packages are not provided.
