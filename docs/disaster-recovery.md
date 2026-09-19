# 备份与灾难恢复 / Backup and recovery

7.0.0 分别记录本地 SQLite 快照、异机备份和恢复验证。健康页和指标读取相同的
持久记录。快照成功不等于异机备份成功，也不证明公网隧道恢复。

## 唯一管理员离线恢复

在可信 Docker 主机终端进入部署目录，先备份数据库和部署密钥：

```sh
sh deploy/scripts/recover-admin.sh -f compose.yaml
# 使用镜像锁、端口池等 overlay 的部署，传入同一组 -f / --env-file 参数。
```

脚本停止控制中心，重置唯一已有管理员并重启服务。输出一小时有效的临时密码，
首次登录必须改密；原管理会话、接入码和 MFA 都被重置，审计不记录临时密码。
不要将终端输出写入公开 CI 日志。恢复后重新启用 MFA，检查审计和已登记设备。
它不会创建第二个管理员，也不能绕过主机权限。控制中心无法停止时应先解决该问题。

## 加密异机备份（标准根目录 Compose）

标准备份镜像支持独立主机上的 HTTPS S3 兼容 bucket。其他 Restic 后端需要单独验证；
SFTP、rclone 等依赖额外客户端工具，默认镜像不包含它们。将高熵仓库密码
保存在部署目录外的 root-only 文件，另留离线副本；备份包不包含解密自己的密码。
在 `.env` 设置下列字段，示例值必须替换，不要提交文件：

```dotenv
HOME_TUNNEL_BACKUP_REPOSITORY=s3:https://s3.your-provider.net/your-bucket/home-tunnel
HOME_TUNNEL_BACKUP_PASSWORD_FILE=/secure/home-tunnel-restic-password
HOME_TUNNEL_BACKUP_AWS_ACCESS_KEY_ID=replace-me
HOME_TUNNEL_BACKUP_AWS_SECRET_ACCESS_KEY=replace-me
HOME_TUNNEL_BACKUP_AWS_REGION=us-east-1
HOME_TUNNEL_BACKUP_HOST=home-server
HOME_TUNNEL_RESTORE_DIRECTORY=./restore
```

```sh
docker compose -f compose.yaml -f deploy/compose.backup.yaml --profile backup build backup
docker compose -f compose.yaml -f deploy/compose.backup.yaml --profile backup run --rm --no-deps backup init
docker compose -f compose.yaml -f deploy/compose.backup.yaml --profile backup run --rm --no-deps backup backup
```

`init` 只对新仓库执行一次。每次备份包含在线 SQLite 一致性快照、标准 Compose、
部署 `.env`、Caddy 配置和六个部署秘密文件；已存在的镜像锁和监控配置也会打包。
`.env` 中备份后端密码/凭据被排除，部署自身的秘密被 Restic 整体加密。
不支持任意宿主机路径、symlink 或外部自定义配置的自动归档；使用定制挂载时，
建立你自己的配置备份清单。应用照片、媒体库和 NAS 数据不在此备份范围。

备份成功前必须完成 `restic check`、全量解密恢复、逐文件 SHA-256、SQLite
integrity/foreign-key 和单管理员检查。失败单独记录，同时保留上次成功时间。
配置监控时启用 backup overlay，健康页才会要求异机备份。

## 定时与保留

`deploy/systemd/home-tunnel-offsite-backup.{service,timer}` 默认每天 03:30 执行，
允许随机延迟。修改 service 的 `WorkingDirectory` 为真实路径，复制到
`/etc/systemd/system/` 后运行：

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now home-tunnel-offsite-backup.timer
systemctl list-timers home-tunnel-offsite-backup.timer
journalctl -u home-tunnel-offsite-backup.service
```

默认不会自动删除异机快照。检查容量并按你的 RPO/保留要求使用 Restic
`forget --dry-run` 查看计划后再执行。删除和 prune 需要独立的维护窗口。
每日备份的最坏数据损失窗口约一天，加上最后一次成功之后的失败时间。

## 在干净主机恢复

安装相同 7.0.0 部署工具，恢复仓库访问凭据和外置仓库密码。选择明确的快照 ID：

```sh
docker compose -f compose.yaml -f deploy/compose.backup.yaml --profile backup \
  run --rm --no-deps backup restore SNAPSHOT_ID --target /restore/recovered
python3 deploy/scripts/import-restore.py --bundle ./restore/recovered --verify-only
python3 deploy/scripts/import-restore.py --bundle ./restore/recovered \
  --destination /opt/home-tunnel-restored --project home-tunnel-restored
```

导入工具只接受空目标目录和全新数据库卷；不会覆盖线上数据，也不会自动启动。
检查目标 `.env`、DNS、防火墙、外部挂载和镜像锁后，在新目录运行原来的 Compose
启动命令。重新建立备份仓库访问配置，因为该凭据不在归档里。

验收顺序：管理员登录、普通用户登录、设备重新连接、测试服务公网 HTTP/HTTPS、
启用的 TCP/UDP、MFA、访问策略、健康页。Caddy 会重新申请公网证书；切换 DNS 前
确认能够完成 ACME 验证及上游限额。保留旧部署直至恢复验收结束。

CI 验证加密归档、干净数据库卷导入和真实管理员登录；本地 Restic 往返及破坏文件
校验也有自动测试。实际云厂商凭据、公网 DNS/证书和家中隧道需由部署者进行演练。

## English quick reference

Keep the Restic password outside the deployment and in an independent offline
escrow. Configure the HTTPS S3 repository and build the optional backup service.
Initialize once; every backup performs a full decrypted restore and integrity
verification before reporting success. Snapshots contain the control database,
standard deployment configuration and keys, not users' media or arbitrary host
mounts. Custom deployments need an explicit supplementary backup inventory.

Restore into an empty directory, run `import-restore.py` with a new Compose project,
review configuration and only then start services. Never restore over a running
database. Verify login, MFA, device reconnection and public tunnels before DNS
cutover. The local test/CI environment cannot certify your cloud provider or public
network. The host-only `recover-admin.sh` revokes management sessions, resets MFA
and issues a one-hour temporary password without creating another administrator.
