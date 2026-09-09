# 自托管部署指南

本指南用于部署 Home Tunnel 6.0 正式版。请将示例域名、IP 和邮箱替换为自己的配置。已有部署请先阅读 [升级指南](UPGRADING.md)。

## 环境和 DNS

需要公网 Linux amd64 / arm64 主机、Docker Engine、Docker Compose，以及可以管理 DNS 的域名。

| 记录或端口 | 示例 | 用途 |
| --- | --- | --- |
| 控制台 DNS | `console.tunnel.example.com` 指向服务器 | 登录与 API |
| 隧道通配符 DNS | `*.tunnel.example.com` 指向服务器 | HTTP / HTTPS 公网连接 |
| TCP 80 / 443 | 主机与云防火墙按需放行 | Web 入口与证书验证 |
| TCP 7000 | 家中客户端可以访问 | 默认 FRPS 接入端口 |

生成配置前确认域名可正确解析。TCP / UDP 公网映射默认不开启，先完成 HTTP 连接验证。

## 选择部署文件

推荐从 [Release](https://github.com/ZHanry/home-tunnel-server/releases/latest) 下载部署包。建立版本目录并解压：

```sh
mkdir home-tunnel-server-6.0.0
tar -xzf home-tunnel-server-6.0.0.tar.gz -C home-tunnel-server-6.0.0
cd home-tunnel-server-6.0.0
```

也可以使用源码：`git clone https://github.com/ZHanry/home-tunnel-server.git`，再进入 `home-tunnel-server` 目录。两种方式共用以下配置步骤。

## 生成配置

```sh
sh deploy/scripts/new-selfhost-config.sh \
  tunnel.example.com 203.0.113.10 \
  console.tunnel.example.com admin@example.com
```

脚本在本地生成 `.env` 与 `deploy/secrets/` 中的鉴权材料和 FRPS 证书。
不要把这些文件提交到 Git，也不要用真实密码替换文档中的示例值再公开分享。
Windows 开发机可使用同目录下的 `new-selfhost-config.ps1`；服务端运行目标仍为 Linux。

## 启动正式版

```sh
docker compose -f compose.yaml config --quiet
docker compose -f compose.yaml up -d
docker compose ps
cat deploy/secrets/bootstrap_admin_password
```

默认使用当前正式版镜像。使用 Release 部署包时，可追加 `-f compose.release.yaml` 固定镜像摘要。源码开发时追加 `-f compose.build.yaml` 并使用 `up -d --build`。
默认项目名为 `home-tunnel`。首次构建需要下载依赖与基础镜像。

打开 `https://console.tunnel.example.com/admin`，读取并使用一次性管理员密码，完成改密，再创建普通用户账号。

## 接入设备与管理 App

从[客户端下载页](https://github.com/ZHanry/home-tunnel-client/releases/latest)获取完整安装包，选择 GUI 或 headless 模式，登录服务端并注册设备。
在控制台创建一个指向本地 HTTP 服务的连接，验证访问、暂停、恢复和客户端重启。

Android 的[正式 APK](https://github.com/ZHanry/home-tunnel-android/releases/latest)用于管理已经注册的设备。它不要求手机运行隧道进程。

## Optional general TCP and fixed-port UDP

The base `compose.yaml` does not publish raw application ports. Overlay files
do not default to a 100-port public range: `HOME_TUNNEL_*_PORT_START` and
`HOME_TUNNEL_*_PORT_END` must be set explicitly or `docker compose config`
fails. Unset bind addresses default to `127.0.0.1`. Choose only one of these
overrides after deciding which protocol and narrow port range you need:

| Override | Enables | Matching `.env` settings |
| --- | --- | --- |
| `deploy/compose.tcp.yaml` | General TCP | `HOME_TUNNEL_TCP_BIND_ADDRESS`, `HOME_TUNNEL_TCP_PORT_START`, `HOME_TUNNEL_TCP_PORT_END` |
| `deploy/compose.udp.yaml` | Fixed-port UDP | `HOME_TUNNEL_UDP_BIND_ADDRESS`, `HOME_TUNNEL_UDP_PORT_START`, `HOME_TUNNEL_UDP_PORT_END` |
| `deploy/compose.l4.yaml` | Both with one numeric range | `HOME_TUNNEL_L4_BIND_ADDRESS`, `HOME_TUNNEL_L4_PORT_START`, `HOME_TUNNEL_L4_PORT_END` |

TCP and UDP have separate port namespaces. The same numeric port may be
assigned once for TCP and once for UDP when both protocols are enabled.
Do not include deployment-reserved ports in a raw range: TCP `80`, `443`,
internal `7000`/`8080`, or the configured `HOME_TUNNEL_FRPS_PORT`; UDP `443`
is also reserved. Caddy owns host `80/443`, while FRPS owns its control and
Web-vhost listeners. The control center and FRPS entrypoint reject these ranges
before starting a misleading configuration.

For example, to make public port `10554/tcp` available for an administrator to
assign, set the TCP range to include it, restrict the same TCP port in the host
and cloud firewalls, validate the merged configuration, and start the stack:

```dotenv
HOME_TUNNEL_TCP_BIND_ADDRESS=0.0.0.0
HOME_TUNNEL_TCP_PORT_START=10554
HOME_TUNNEL_TCP_PORT_END=10554
```

```sh
docker compose -f compose.yaml -f deploy/compose.tcp.yaml config --quiet
docker compose -f compose.yaml -f deploy/compose.tcp.yaml up -d
```

Use `deploy/compose.udp.yaml` with the `HOME_TUNNEL_UDP_*` range for UDP only,
or `deploy/compose.l4.yaml` with the `HOME_TUNNEL_L4_*` range to publish both
protocols. When running the ARM64 profile from the `deploy/` directory, use the
corresponding local filename such as `compose.udp.yaml` or `compose.l4.yaml`.
If both protocols need different ranges, intentionally combine the TCP and UDP
profiles and set both protocol-specific groups. Do not combine profiles unless
you have checked the merged Compose port bindings and environment values.
Before removing an overlay or narrowing a range, disable every connection
outside the new range while the old configuration is still active. After the
Compose change, re-apply affected connections so clients receive a fresh full
configuration; FRPS rejects any stale out-of-range proxy in the meantime.

After the deployment is healthy, an administrator can create a connection and
assign one exact public port inside the enabled range. TCP carries an arbitrary
TCP byte stream; RTSP is not a separate tunnel type. A camera listening on
local `554/tcp` can be published as public `10554/tcp`, then opened with:

```sh
ffplay -rtsp_transport tcp rtsp://PUBLIC_HOST:10554/path
```

Replace `PUBLIC_HOST` with the reachable host or address configured as
`HOME_TUNNEL_FRPS_PUBLIC_HOST`.
For an IPv6 literal, keep the configuration value unbracketed and bracket it
in application URLs, for example
`rtsp://[2001:db8::10]:10554/path`; API `public_endpoint` values are formatted
this way automatically.

For native RTP/RTCP over UDP, configure the camera to use fixed media ports and
create one UDP connection for each port. Dynamic or randomly negotiated media
ports are not guaranteed to work. Raw IP, ICMP, broadcast, multicast, STCP,
XTCP, SUDP, visitor configurations, and arbitrary FRP plugins are not
supported.

TCP and UDP traffic go directly to FRPS and bypass Caddy and the Traffic
Gateway. Gateway Basic Auth, IP allowlists, rate limits, traffic metering, and
monthly quotas therefore do not apply. Require the target application to
authenticate users and encrypt sensitive traffic. Apply protocol/port source
restrictions and rate limits in the host or cloud firewall. UDP services can
be abused for reflection/amplification; assess the protocol and limit sources
and rates before exposing it.

## 日志和日常测试

```sh
docker compose ps
docker compose logs --tail 100 control-center traffic-gateway frps caddy
```

修改代码后使用相同的基础文件、构建覆盖文件，以及本次测试启用的 TCP / UDP 覆盖文件重新构建。
记录参与联调的客户端提交；按兼容性说明选择组件版本。

## 数据与备份

SQLite 位于 `sqlite-data` 卷的 `/data/home-tunnel.db`，Caddy 的状态使用单独的持久化卷。
控制中心包含定时数据库快照，备份位置、周期和保留数可通过服务配置调整。
同一数据卷中的快照不能替代主机外备份；测试恢复时保留部署密钥和原始数据副本。

暂停测试环境可以使用 `docker compose stop`。普通停止或重新构建不需要删除数据卷。
只有明确准备重建全部测试数据时才考虑删除卷，并事先确认目标环境和备份。
底层数据库结构和配置可能在测试期变化，相关改动需在开发记录中说明。

## 排查顺序

1. 核对 DNS、HTTPS 和云 / 主机防火墙。
2. 核对容器状态及控制中心、FRPS 日志。
3. 核对家中客户端是否在线、是否能直接访问本地目标。
4. 核对连接归属、启用状态、域名或分配端口。
5. 使用测试账号复现，记录提交 SHA、时间和脱敏后的错误。

安全边界见 [SECURITY_MODEL.md](SECURITY_MODEL.md)，版本发布见 [RELEASING.md](RELEASING.md)。
