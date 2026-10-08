# HomeDesk 11：内网穿透与 P2P 远控

HTTP/HTTPS、受控 TCP/UDP、端口池、权限、访问控制、流量治理、诊断与独立 CLI/NAS Agent 完整保留。FRPS、traffic-gateway、Caddy 和 Node/SQLite 管理台继续负责这些功能。

内置远控采用 RustDesk 1.4.9 核心，必须端到端加密并直接连接。服务端只增加 hbbs 1.1.16 信令/NAT 服务；不启动 hbbr 或 TURN，也不将远控流量转入 FRPS、HTTPS/WSS 网关或供应商服务器。直连失败会终止。部分 NAT、CGNAT、移动网络及防火墙组合可能无法直连。

## 首次配置

1. 按原自建部署步骤准备域名、TLS、密钥、SQLite 备份及穿透端口池。先运行 `docker compose up -d hbbs`。
2. 将公钥复制到宿主机：`docker cp "$(docker compose ps -q hbbs):/root/id_ed25519.pub" ./hbbs-public-key.txt`，再读取 `hbbs-public-key.txt`。镜像内没有 shell 或 cat；只复制 `.pub`，不要复制或公开私钥。
3. 在 `.env` 同时设置 `HOME_TUNNEL_HBBS_SERVER=你的信令域名:21116` 和 `HOME_TUNNEL_HBBS_PUBLIC_KEY=上一步的Base64公钥`，再启动完整服务。
4. 防火墙允许 hbbs 的 TCP 21115、TCP/UDP 21116；不开放 21117、21118、21119。FRPS 和 HTTP/TCP/UDP 服务端口仍按原部署规则开放。
5. 在 HomeDesk“配置 P2P 远控”填写相同的服务器、公钥及家庭私网 CIDR。通用安装包不内置任何服务器、公钥或登录凭据。登录家庭服务并接入这台电脑后，由设备会话登记远控 ID。

管理台只有 hbbs 公钥配置，无权访问 hbbs 私钥卷。设备 ID 映射写入原 SQLite，设备撤销立即移除映射；目录只向当前账号返回其有效设备。`online` 表示 90 秒内收到登记，并非远控连接已经成功。

## 升级与独立运行

备份原 SQLite、部署 secrets、hbbs 密钥卷和客户端状态，再覆盖升级。旧浏览器远控与 TURN 退出 11.x 的生产路径；旧远控配置不会重新启用中继。不要继续叠加历史 `compose.rd.yaml` / `compose.turn.yaml`。

现有 SQLite/Restic 备份工具不包含 `hbbs-data` 命名卷；升级、迁移前还必须单独保存信令身份。使用宿主机 GPG 和 Docker，从 Compose 获取 hbbs 容器 ID，执行：

```sh
chmod 600 deploy/secrets/backup_passphrase
python3 deploy/scripts/hbbs-identity.py backup --container "$(docker compose ps -q hbbs)" \
  --file hbbs-identity.gpg --passphrase-file deploy/secrets/backup_passphrase
python3 deploy/scripts/hbbs-identity.py verify --file hbbs-identity.gpg \
  --passphrase-file deploy/secrets/backup_passphrase
```

将加密文件与解密密码分开保存。恢复时先恢复原部署配置，再使用 `restore --volume 新项目名_hbbs-data`（另两个参数与 verify 相同）；必须是未存在的卷。工具校验公私钥对应关系、文件哈希和归档路径，不覆盖已有身份，也不自动启动服务。hbbs 的临时登记数据库可由设备重新登记。启动后确认公钥指纹与控制中心 `.env` 相同，再测试设备登记和 P2P。

远控网络模式或连接失败不会停止内网穿透。修改管理台授权地址、退出相关账号或撤销设备仍会终止其受管 Agent。GUI 内的 Agent 跟随窗口；长期运行请选择 Release 合集中保留的独立 CLI/Agent，并按对应平台后台运行说明配置。

## 当前候选验证范围

11.0.0-rc.2 为候选版本。自动测试、构建和安装包校验不能替代两台机器的屏幕/输入、声音/剪贴板/文件，以及家庭宽带与移动网络直连测试。发行材料记录真实检查结果和待验收项目；不将历史 10.x 的验收结果计为 11.x 已通过。
