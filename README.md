# nestlink

Web 管理与浏览器内远控服务端，提供账号、信令、授权和穿透控制。 当前发行目标 **13.0.0 正式版**，正在实施和验收。

使用自己的 HTTPS 服务和账号登录，连接配置自动获取。远控要求认证加密 P2P 直连及被控端批准或密码验证。HTTP/HTTPS 与受控 TCP/UDP 穿透、权限、端口池、访问控制和流量治理保留。

平台、升级、验证边界与构建材料见 [13.0.0 说明](docs/HOMEDESK_RELEASE.md)。桌面客户端集中管理后台穿透，不分发独立 CLI/NAS 或 macOS GUI。旧界面截图从当前文档中移除。

[项目入口](https://github.com/ZHanry/home-tunnel) · [English](README.en.md) · [构建与来源](docs/BUILDING.md)

Android 保留原 applicationId 与发行证书；Windows/Linux 保留安装升级和配置身份。冻结认证契约 api-v2.0.0 保持不变，浏览器远控使用独立版本契约。原 Go 代码按 Apache-2.0 分发，整合 Rust/Flutter 代码遵循 AGPL-3.0，发行材料包含对应源码和许可证。历史记录见 Git 标签和 GitHub 发行页。
