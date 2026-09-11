# Changelog

## 6.2.0 — 2026-09-11

- 管理员网页新增 TCP/UDP 启用、池内范围、占用统计和持久化设置，保存后立即生效。
- 协议策略统一应用于分配、编辑、同步和 FRPS 接入，增加并发修改及已启用连接保护。
- 新增一次性端口池部署覆盖文件；保留旧部署默认行为及客户端 6.1.1 兼容性。
- 增加 API、重启持久化、浏览器与正式镜像跨架构联调验证。


## 6.1.1 — 2026-09-09

让发布联调的连通性、撤销检查与证据报告使用接口返回的实际端口。

## 6.1.0 — 2026-09-09

- 为客户端开放受控的 TCP/UDP 创建接口，端口从部署配置允许的范围内原子分配。
- 增加 RTSP、SSH 和 RDP 应用预设元数据，RTSP 地址使用 rtsp:// 显示，底层仍由受管 TCP 隧道转发。
- 控制台新增普通用户 TCP/UDP 自助创建授权，默认关闭；管理员可在自己的设备上创建。
- 返回传输能力和权限状态，旧版客户端保持兼容，设备间资源隔离继续生效。
- 增加并发端口分配、端口耗尽与回收、权限和跨设备访问回归检查。

此版本不会自动开放服务器防火墙或 Docker 端口。请保留现有配置，按 [自托管指南](https://github.com/ZHanry/home-tunnel-server/blob/v6.1.0/docs/SELF_HOSTING.md)启用所需的 TCP/UDP 范围，并使用客户端 6.1.0。已有连接保持原端口。


## 6.0.1 — 2026-09-09

更新发布联调的首页验证规则，与全新下载入口保持一致。服务端使用正式客户端 6.0.0 验证两种 Linux 架构。

## 6.0.0 — 2026-09-09

Home Tunnel 6.0 正式发布。Web、桌面与手机端采用全新的页面结构，统一使用清晰的设备与账号边界。

- 顶部导航与全新总览、用户、设备和连接布局，适配手机、平板与桌面。
- 支持删除普通用户，同时撤销会话和设备凭据、停止并删除连接。历史审计与流量保留。
- 自动合并旧部署中的多个管理员角色：保留最早的有效管理员，其余账号转为普通用户。
- 设备会话的连接、域名、流量与实时通知限制在本机，管理会话继续管理账号名下的全部设备。
- Release 提供部署压缩包、固定镜像摘要的 Compose 文件和校验清单。

升级前备份数据库与配置，升级全部组件至 6.0.0。详见 [升级指南](https://github.com/ZHanry/home-tunnel-server/blob/main/docs/UPGRADING.md)。


## Unreleased · 正式发布

- 当前仓库负责API、Web 控制台、网关与服务端部署。
- 统一开发文档、源码构建入口和正式发布状态。
- 自动化检查与真实环境反馈共同用于后续功能完善。

以下为 5.x 早期版本的历史记录；从 6.0 起按正式发布流程维护。
后续用户可见变化在这里记录，并注明影响到的接口、配置和测试步骤。


## 5.0.1 · Security maintenance

- Bound Bearer header parsing and added public/API, password-change and DNS-verification rate limits.
- Replaced substring host matching with parsed host comparison.
- FRPS builds use reviewed locks for go-ntlmssp v0.1.1 (CVE-2026-32952).
- Security CI now checks open CodeQL findings after analysis.
