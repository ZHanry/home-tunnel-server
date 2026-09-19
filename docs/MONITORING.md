# 监控与通知 / Monitoring

可选栈：Prometheus 3.14.0、Alertmanager 0.34.1、Blackbox Exporter 0.28.0、
Grafana 13.2.2。控制中心已有 `/internal/metrics`，包含低基数延迟直方图、设备、
流量和备份状态。内部密钥只通过文件传递；内部端口不对公网开放。

```sh
python3 deploy/scripts/prepare-monitoring.py
docker compose -f compose.yaml -f deploy/compose.monitoring.yaml \
  --profile monitoring up -d
```

预生成脚本读取 `.env` 的真实 HTTPS 控制台地址，生成 Prometheus 配置和 Grafana
密码文件，绝不打印密码。管理员从 `deploy/secrets/grafana_admin_password` 私下
读取密码。Grafana 仅绑定 `127.0.0.1:3000`；远程访问使用 SSH 转发，例如
`ssh -L 3000:127.0.0.1:3000 your-server`。不要直接公开管理面板。

面板和数据源自动预置。规则覆盖控制中心/HTTPS 不可用、证书 14 天内到期、
本地快照超过 36 小时、异机备份失败或过期、恢复验证过期、设备离线、p95 延迟
超过 1 秒和通知发送失败。数据保留 15 天，阈值可按实际负载调整。默认探测 IPv4；
IPv6-only 部署需调整 `blackbox.yml` 的 `preferred_ip_protocol`。

Alertmanager 经内部认证的 `/internal/monitoring/alerts` 转发到部署已有的
Webhook/Telegram 通道。只允许使用管理员配置的目标，HTTP 请求不能指定收件人。
未配置通道时返回明确错误，通知失败返回可重试状态。Webhook/Telegram 配置见
[部署说明](SELF_HOSTING.md)（若使用独立部署，请同时保留原来的通知环境变量）。

管理员可在控制台运行「测试告警」检查自己已配置的通道。这会真实发送通知。
先确认目标和接收人；配置验证命令不会发送测试消息：

```sh
docker compose -f compose.yaml -f deploy/compose.monitoring.yaml --profile monitoring \
  exec prometheus promtool check config /etc/prometheus/prometheus.yml
docker compose -f compose.yaml -f deploy/compose.monitoring.yaml --profile monitoring \
  exec alertmanager amtool check-config /etc/alertmanager/alertmanager.yml
```

同时启用 backup overlay 时，把两份 overlay 都保留在后续启动命令中。
监控额外需要约 1 GiB 内存预算；端口池和应用媒体流量不计入监控预算。

English: generate the configuration, start the optional Compose monitoring profile,
and access Grafana through localhost/SSH forwarding. Credentials stay in secret
files. The provisioned dashboard and nine alert rules cover availability, TLS,
backups, restores, offline devices, latency and delivery failures. Notifications
use only preconfigured administrator channels. The console's alert test sends a
real message; configuration validation is offline and sends none.
