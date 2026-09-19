# 账号、双重验证与设备接入

7.0.0 的 Web「我的账号」和 Android 账号页面提供 TOTP 验证器、恢复码、
管理会话列表和一次性接入码。每套部署仍只有一位管理员。

## 启用 TOTP

输入当前密码，在验证器中手动添加页面显示的密钥，类型选择 TOTP、6 位、
30 秒，然后输入生成的动态码确认。待确认密钥 10 分钟后过期。
确认后一次显示 8 个恢复码；离线保存，每个只能使用一次。服务器仅保存恢复码
哈希，TOTP 密钥用部署的内部密钥加密。不要删除或随意替换部署密钥文件。

登录、改密和敏感 MFA 设置需要动态码或恢复码。动态码不能复用；启用、关闭或
重置 MFA 后，其他管理会话和未消费接入码失效。已登记设备的长期接入权限需要在
「设备」中单独撤销。恢复码用完前生成新一组，旧组立即失效。

## 新电脑无需输入账号密码

在 Web 或 Android 中生成接入码，选择客户端「一次性接入码」，输入**同一套
部署的 HTTPS 地址**和该码。码有效期 10 分钟、只能登记一次、不能跨部署使用。
备注仅帮助区分用途；接入后可按设备撤销。CLI 可用：

```sh
home-tunnel-client enroll --server https://console.your-domain.net \
  --device-name home-nas --enrollment-code-file /secure/enrollment-code
```

秘密文件应仅当前用户可读，用后删除；不要把码、密码或令牌写入 URL、截图、
工单或 shell 命令行参数。CLI 密码登录使用 `--password-file`，MFA 使用
`--mfa-code-file`。Android 只管理账号，隧道运行在已登记电脑或 NAS。

## 会话与找回

会话页可撤销某个 Web/手机登录；撤销当前会话会立即退出。修改密码会使旧会话
失效。手机支持保存最多 20 个服务器/账号，切换清除视图缓存，令牌仍由
AndroidKeyStore 保护。移除保存项只删除本机副本；先注销才能撤销服务器会话。

普通用户联系管理员重置密码。唯一管理员丢失密码、验证器和恢复码时，使用
[主机离线恢复](disaster-recovery.md#唯一管理员离线恢复)，不是公开的 HTTP 重置接口。

## English

Enable a six-digit, 30-second TOTP authenticator from **My account** in Web or
Android. Enter the current password and confirm with a fresh code within ten
minutes. Store the eight one-use recovery codes offline. MFA changes revoke other
management sessions and unused enrollment codes; revoke enrolled devices separately.

Enrollment codes expire in ten minutes, are single-use and belong to one
deployment. Enter the same HTTPS server origin on the new desktop/CLI. Secret-file
CLI options avoid exposing credentials in process arguments. Android stores up to
20 encrypted server/account profiles and does not run tunnels. Local profile
removal does not imply server revocation. Use the host-only recovery procedure
when the sole administrator loses every authentication factor.
