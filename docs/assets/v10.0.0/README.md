# 10.0.0 Web 截图来源 / Web screenshot provenance

- 产品 / Product: Home Tunnel server 10.0.0
- 源码 / Source: [`v10.0.0` at `9e5b4ff4e6381a42317c94618d1805b7398c558e`](https://github.com/ZHanry/home-tunnel-server/tree/9e5b4ff4e6381a42317c94618d1805b7398c558e)
- 采集 / Capture: 2026-09-30 01:31:23 UTC, Chromium 145.0.7632.6, zh-CN, 1440 × 960 viewport, full-page PNG
- 原始产物 / Original artifact: [GitHub Actions run 36655463870](https://github.com/ZHanry/home-tunnel/actions/runs/36655463870), artifact ID `11072925181`
- 原始清单 / Original manifest: [manifest.json](manifest.json)

三个 PNG 与采集时的清单逐字节保留，未裁剪、重绘或压缩替换。清单记录每张图的 SHA-256、文件长度和像素尺寸，以及源码、依赖锁和采集脚本摘要。

All three PNG files and the capture-time manifest are preserved byte-for-byte, without cropping, repainting, or replacement compression. The manifest records image SHA-256 hashes, byte lengths, dimensions, and source, lockfile, and capture-script identities.

## 数据与范围 / Data and scope

截图使用仓库自带 `control-center/scripts/ui-preview.mjs` 的示例数据。产品 UI 源码未修改。采集环境额外启用远程桌面能力，并提供空的远程设备列表；没有连接真实 Windows 主机或验证远控会话。图中的账号、设备、流量与健康状态属于预览数据，不能作为生产状态或功能验收证据。

The captures use example data from the repository's `control-center/scripts/ui-preview.mjs`. Product UI source is unchanged. The capture environment additionally enables the remote capability and supplies an empty remote endpoint list. No real Windows host was connected and no remote session was verified. Accounts, devices, traffic, and health indicators are preview data, not production-state or acceptance evidence.

## 图片复核 / Visual review

2026-09-30 UTC 已逐张检查原始图像：

- [admin-console.png](admin-console.png)：系统总览，包含示例统计、快速开始和组件状态 / Dashboard with example metrics, quick-start controls, and component status
- [tunnel-wizard.png](tunnel-wizard.png)：发布内网服务向导的“设备与模板”步骤，未发布连接 / Publishing wizard's device-and-template step, with no connection published
- [remote-entry.png](remote-entry.png)：远程桌面入口，显示“还没有被控电脑” / Remote desktop entry showing an empty host list

All original images were visually inspected on 2026-09-30 UTC. This review confirms the pictured UI and captions, not end-to-end functionality. The immutable capture manifest retains its original `captured-awaiting-visual-review` status; this document records the later visual review separately.
