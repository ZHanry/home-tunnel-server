# HomeDesk 11.0.0-rc.2 服务端候选

保留 HTTP/HTTPS、受控 TCP/UDP、端口池、权限、ACL、流量治理、诊断和独立 CLI/NAS Agent。暖居 Web 管理台提供原生 HomeDesk 入口；同账号设备目录写入原 SQLite，撤销设备会清除映射。

远控使用 RustDesk 核心，固定认证加密 P2P。新增 hbbs 1.1.16 信令，64 MB 内存上限；没有 hbbr/TURN 或 FRP/网关远控回退。打洞失败会停止。旧网页媒体引擎退出生产路径。

三个附件：部署 tar.gz、源码/许可证/构建检查材料 ZIP、SHA256SUMS.txt。材料中的 BUILD.json 及 Sigstore 证明绑定本次源码与实际交付文件；部署镜像使用固定摘要。

升级前备份 SQLite、secrets、hbbs 私钥卷和客户端状态。先按 docs/HOMEDESK.md 配置 hbbs 地址/公钥，再启动客户端。设备目录只提供元数据；实际远控仍需被控端密码或批准。跨公网 NAT、持续媒体和实机验收待完成，候选版不表示这些测试已通过。
