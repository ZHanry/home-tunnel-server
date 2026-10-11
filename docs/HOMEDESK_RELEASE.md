# NestLink 14.0.1 维护版

服务端运行版本、Web 缓存键、下载入口及发行组合同步为 14.0.1，保留统一 NestLink 品牌与“设备管理、远程协助、内网穿透”导航。内部 gateway 健康检查使用配置中的端口。冻结认证 API、浏览器/设备能力扩展、安装身份与安全机制保持兼容，最低服务端仍为 14.0.0。

Server 14.0.1 uses the configured gateway port for internal health checks. This exact C combination retains the management and authorization behavior; its actual runtime scope is recorded below. The running production service is not upgraded.

C 产物源码为 `b73ab0472cde66b8a06c1307bbca4b3fb34785df`，来源为成功的 [Server CI 38167376775](https://github.com/ZHanry/home-tunnel-server/actions/runs/38167376775)（attempt 1）。本版实际验收见 [acceptance-14.0.1.json](release/acceptance-14.0.1.json)。

| C 固定产物 | SHA-256 |
| --- | --- |
| NestLink-Server-14.0.1.tar.gz | `c3160a95220d9098aa9ca4c39b5c0f2e273ddd7af0a28ed4298894fd078fa474` |
| control-center amd64/arm64 | `sha256:026f676cd6112e99d68c2f7f33fd7681bc4f88d35d915e717cb5bad1835e83ba` |
| traffic-gateway amd64/arm64 | `sha256:c721f0e1560223795da2c63c4d1ce2c54d05c8b14997914f53dd1a27557dc1aa` |
| FRPS 独立固定依赖 | `ghcr.io/zhanry/home-tunnel-frps@sha256:69dd1e9a05dbef35f44436db77f88e266a2772d57a86f889ffbd982ca7798ddb` |

产物源码提交用于绑定已构建的 C 运行时字节；正式 `v14.0.1` 标签提交还会包含本版验收 JSON 与两份发行文档。本版 owner waiver 仅允许三个发行文档与 `scripts/homedesk-release.py`、`scripts/test_homedesk_release.py` 两项政策文件相对产物源码变化；逐场景绑定这两份政策的实际 SHA-256，运行时字节保持固定。验收 `source_revision/build_run` 保留 C 产物来源，正式 Materials 的 `BUILD.json.revision/build_run` 另记实际正式提交与 release.yml run，`payload_source_revision` 保留 C 来源；正式 Materials、附件签名和校验和在真正发布后独立核验，不宣称文档提交重新构建了产物。

此前 A/B 的故障、安装链和原始尝试单独保留，13.0.0、14.0.0 及 A/B 结论不替代 C。用户取消后续远控回归并要求直接发布。未执行的 C 运行时场景明确记录为 not_run 和 owner waiver，不推断通过；通过场景才绑定实际执行原件。

本次仅更新 GitHub 发行、下载站和自动更新信息；正在运行的生产服务端保持原版本。

The acceptance source and candidate build run identify the exact C payload bytes. Formal documentation commits and release-workflow runs remain separate. Unfinished runtime scenarios remain not_run under the explicit owner waiver. Only GitHub releases, downloads and update information change; the running production server is not upgraded.

## 本版实际验收范围

状态：`accepted_with_waivers`。用户授权原话：`不需要远控回归,直接做后面的`。

Exact C build provenance and payload hashes are verified. The original candidate checksum Sigstore signature and immutable application image signatures are verified. Formal Release Materials and stable/latest tag resolution are verified separately after publication. Pending installed-product remote, authorization, account and tunnel runtime scenarios are not_run after the owner requested direct publication. The Android C overlay is the sole passed required installed-product scenario. Existing local Linux overlay evidence remains a separate completed check. No production server deployment or Windows reinstallation is performed.

- **account-migration**：not_run — The owner stopped pending remote-control regression and requested direct publication. This unfinished runtime scenario remains not_run; exact-source CI and payload/signature verification do not constitute installed-product runtime acceptance.
- **browser-authorization**：not_run — The owner stopped pending remote-control regression and requested direct publication. This unfinished runtime scenario remains not_run; exact-source CI and payload/signature verification do not constitute installed-product runtime acceptance.
- **managed-tunnels**：not_run — The owner stopped pending remote-control regression and requested direct publication. This unfinished runtime scenario remains not_run; exact-source CI and payload/signature verification do not constitute installed-product runtime acceptance.
- **native-authorization**：not_run — The owner stopped pending remote-control regression and requested direct publication. This unfinished runtime scenario remains not_run; exact-source CI and payload/signature verification do not constitute installed-product runtime acceptance.

签名范围：The original candidate checksum Sigstore signature and immutable application image signatures are verified. Formal Release Materials and stable/latest tag resolution are verified separately after publication.

准备过程实际记录（不替代运行时回归）：

- **linux-c-payload-overlay**：`passed` — Exact C Linux x64 payload installed with identity, configuration and keyring preserved; GUI and media not run.
- **private-fixture-c-conversion-preflight**：`failed_before_dispatch` — The private application-image transition refused its shim identity preflight before any dispatch. Existing B application containers and FRPS remained unchanged. No C GUI or runtime fixture acceptance is asserted.

## UI 与健康观察

本版 C 产品 UI 与健康回归未完成；保留官网真实 14.0.0 图库、原 capture manifest 和 SHA-256，并明确标注 14.0.0 截图参考。没有 C 真实界面矩阵，不把历史像素改版本冒充新版截图。此前 B 的中文 remote placeholder 和 gatewayUnhealthy 观察保留为历史记录。本版 C 的中文初次打开、EN↔ZH 既有表单切换及健康结果须按实际原件判断，文档不会据源码 CI 或截图 helper exit 0 推断通过。英文管理区“策略队列/备份”的混合语言观察仍保留；未覆盖的管理员项与 FRPS 健康没有本版通过结论。

## 限制与未测范围

Windows 14.0.1 本机清装与 GUI 未实测；安装器由 CI 验证且没有 Authenticode，Materials 的 Sigstore 签名不能替代平台可执行文件签名。Linux ARM64/Wayland 实机媒体、实体 Android、运营商 NAT、长期媒体，以及音频/文件/剪贴板等未测范围继续如实保留。Android 被控方向、PIN/`trusted_devices` 与安装归属不宣称全部通过；具体边界以下方本版 unverified 原列表为准。历史安装链不等同于直接公开 13→C，synthetic 迁移不等同于生产原数据库升级。

既有审查记录的 18 个 open 依赖告警（3 high、7 medium、8 low）及具体未修复依赖继续保留；没有通过版本同步关闭或 dismiss 告警，历史审查不是新的动态可达性或利用测试。Linux `users` 0.10.0/0.11.0、受影响的 `libgit2-sys` 构建输入、其他 glib/users 与 atty 风险没有由本维护修复消除。

Windows local installation/GUI, physical Android/ARM64, Wayland media, carrier NAT and long-duration media remain outside the tested scope unless the original C acceptance explicitly records otherwise. Windows has no Authenticode signature, and the existing dependency advisory scope remains unresolved. Production deployment is not part of this release.

本版原验收 unverified：`account-migration`, `browser-authorization`, `carrier-network-nat`, `current-c-product-ui-matrix`, `local-windows-14.0.1-reinstallation`, `long-duration-media`, `managed-tunnels`, `native-authorization`, `physical-android-device`, `physical-linux-arm64-gui`。

## 已发布 14.0.0 历史记录

# NestLink 14.0.0

服务端 Web 与桌面、Android 统一 NestLink 品牌、客户端 SVG Logo、紫色主题、图标和“设备管理、远程协助、内网穿透”导航。语言、主题和版本集中在顶部，账号入口在导航底部；管理员总览、用户、审计和系统策略保留在管理区。登录、首次改密、设备、穿透编辑与详情、账号和会话界面使用一致控件与中英文名称。

迁移 026 和 `nestlink-device-capabilities-v1` 版本扩展按明确关联显示物理设备，分别展示远控与后台能力，同名设备独立。管理员全域能力查询仅允许管理员读取，按账号关联；远控和穿透分别使用自己的主体。普通删除原子撤销两种能力并保留服务配置，永久删除仍单独确认和校验权限。冻结认证 API、安装身份和安全凭据机制保持兼容。

发行复用源提交 `299753a4c6580ac6bbc748cdee743489a3e17dba` 的 [Server CI 38053932107](https://github.com/ZHanry/home-tunnel-server/actions/runs/38053932107) 已验收产物。正式标签相对构建来源仅追加本版验收 JSON 和两份发行文档。详细来源、执行时间、原件摘要及未测范围见 [acceptance-14.0.0.json](release/acceptance-14.0.0.json)。

| 产物 | 已验收摘要 |
| --- | --- |
| NestLink-Server-14.0.0.tar.gz | `1a42bc2e9520c9d4d7c641af6bc3fff42bd9833880423b767485779f4e8812a7` |
| control-center | `sha256:b6e43b72494cca541c023b366e27504a46ac1acea0ec4c504adb4f15a6b0cb46` |
| traffic-gateway | `sha256:8c07824ea38e5cf2297ad0ff80711c90f688b1a82f7fe9dc62d406a9328515cb` |
| FRPS 0.70.1-r4 | `sha256:69dd1e9a05dbef35f44436db77f88e266a2772d57a86f889ffbd982ca7798ddb` |

control-center 和 traffic-gateway 提供 Linux amd64/arm64 镜像，候选清单、部署包和镜像签名均独立验证；FRPS 使用单独签名的固定依赖。本地完整联调为 amd64，CI 双架构构建及 smoke 不代表本机 ARM64 完整运行。

迁移验收使用活动数据库的 SQLite 备份副本，在副本移除 026 对象后进行 schema25→26 重放，公开 13.0.0 镜像启动后升级到确切 14.0.0 镜像。5 台设备身份/凭据和 1 个服务配置摘要保留，活动数据库和生产部署没有升级。服务端六项授权、事务回滚和删除 API 检查，以及四项真实网页目录、权限和窄屏布局检查独立保存；37 个实际静态资源与源码及镜像绑定。历史服务端单独检查没有重新标记为后来 feaf/dcdf 消费者参与。

本轮新客户端 `feaf1181efe55076dead52931203a8488cbad20d` 实际完成原生跨账号批准、紫色工具栏、真实画面、键盘标记和反向 TCP 端点配对。再次建立连接后撤销前台管理会话，远控连接消失，两种设备主体仍有效，HTTP、HTTPS 后端、TCP、UDP 四种穿透仍通。随后整机原子撤权使两主体、租约和所属会话失效，四种协议全部阻断。服务配置、其他同账号设备及其他账号授权状态保持。真实三阶段结果和任务 raw-tunnel 策略恢复原件分别保存。

浏览器批准、拒绝、错误密码、离线目标、管理会话撤权和正确固定密码六项实测通过。允许场景有真实画面和键盘输入，拒绝场景零画面并关闭连接，撤权返回 204 后 27 毫秒内断开。测试使用任务私网 STUN-only 后端与认证加密直连 UDP；118 个原件、失败尝试和单独范围记录保留。

新客户端对独立签名 13.0.0 服务的五项兼容检查通过，包含缺失扩展降级、明确配对与同名设备、主体选择及保留配置的旧接口删除。独立 UID1004/display144 的 32 次实际操作、原图和路由审计作为独立兼容范围，不覆盖 13 服务的媒体或穿透流量。Linux 13→14 的确切包冷恢复与 profile 保留另行记录，前置 profile 最初由早期 14 测试建立。

B 密码设置使用既有 root-admin IPC 临时 PIN 和真实 GUI。最初设置 PIN 的严格检查仍失败，因为额外 trusted_devices 变化的原语义未知；后续读取和清理通过，只清空 unlock_pin，A/root 配置保持。GUI 已恢复本机确认并锁定设置，测试固定密码保留。系统 root 密码 GUI 解锁未验证。

隔离联调使用 WSL X11、自签 TLS、host-network 健康 URL 适配、localhost 桥、HBBS LAN mask 和 STUN-only 后端。部分 API/Web 场景跳过任务自签证书验证，原故障与恢复记录保留。Windows/WSL 原始时间戳不改写，历史迁移结束时间的两个时钟域相差 3.394682 秒；未找到独立原始 GBK traceback 的证据限制继续披露。

Windows/ARM64/Wayland 媒体、Android 真机、Android ARM64 运行、模拟器被控媒体、运营商 NAT、长期媒体、公开 CA/生产 TLS、音频、剪贴板、文件传输以及本轮未执行的完整备份恢复仍未验证。Android 已通过的媒体方向为手机控制 Linux；模拟器 slirp 内部地址导致反向测试失败，未修改产品安全策略或原安装归属。

本次更新 GitHub 发行、下载站和自动更新信息，生产服务端继续运行原版本。14.0.0 使用自己的验收记录，13.0.0 历史结论单独保留。
