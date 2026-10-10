# 一台设备的远控与穿透能力

远程控制和内网穿透是同一台物理设备的能力。认证仍保留两个凭据主体：GUI 主体依赖有效账号管理会话，background 主体供隧道运行时使用。物理设备关联不会交换凭据、改变授权 scope、迁移服务或租约。

迁移 026 新增 device_capability_links，记录同账号 GUI UUID 与 background UUID 的一对一明确关联。物理设备的 canonical ID 为 GUI UUID。关联不依据设备名称推断。

## 独立契约

`nestlink-device-capabilities-v1` 以 `contracts/nestlink-device-capabilities.v1.json` 和 JSON Schema 描述接口，`contracts/device-capabilities.lock.json` 锁定 SHA-256。认证仍采用不可改写的 `api-v2.0.0`；此扩展不属于旧冻结标签。当前聚合 OpenAPI 通过 `x-extensions` 与各操作的 `x-extension-ref` 标明扩展。生成后必须核对独立锁，三个客户端读取同一扩展版本。

## 接口

- POST /api/v2/auth/device-capabilities/link：账号管理会话提交 remote_device_id 与 tunnel_device_id；两者必须同账号、active 且分别为 gui/background。新建返回 201，重复相同关联返回 200，一对一冲突返回 409。客户端仅应提交由自身受控原生运行时确认的本机 GUI 与 Agent 身份。
- GET /api/v2/auth/device-capabilities：返回 version=1 及 items。每项仅有 physical_device_id、remote_device_id、tunnel_device_id，不含令牌或凭据。如果管理员单方撤销某能力，该能力返回 null，剩余能力保留原物理设备 ID；双方都失效后不返回该项。
- DELETE /api/v2/auth/device-capabilities/:remoteId：按 canonical ID，在一项事务中撤销两个主体、会话与租约，发送各主体撤销事件并记录审计，保留服务配置。旧 DELETE /api/v2/auth/devices/:id 命中已关联主体时也撤销整个物理设备；未关联设备保持原行为。

- GET /api/v2/admin/device-capabilities：仅允许正常管理员账号管理会话，返回 version=1 和含 user_id 的关联列表，支持可选 user_id UUID 筛选。只读地保留已撤销主体的原始 UUID，便于管理员将历史记录归并；账号接口继续按有效能力返回 null。不会提供跨账号关联或撤权写权限。

所有接口保留账号正常状态检查。写接口保留 cookie CSRF 检查，并在事务内重新核对管理会话。设备会话、原生远控委托会话不能建立、查询或撤销账号目录关联。

## 客户端映射

目录按 physical_device_id 归并、计数，能力分别携带 subject UUID。远控绑定、签名、许可、浏览器远控继续使用 remote_device_id。隧道服务新增、筛选、同步、租约、心跳继续使用 tunnel_device_id。现有服务的 device_id 不改写；设备 metadata 的版本继续按原主体核对。不要把 canonical ID 直接替代所有请求的 device_id。

旧 /client/devices 仍返回兼容的主体列表，增加 credential_purpose（gui/background）字段供客户端识别未关联的能力；同时返回可选 client_type（优先采用远控绑定的平台，其次采用最近设备会话的类型），用于电脑与手机分组；两字段由独立 DeviceCapabilityFields schema 锁定。分页、主体 UUID 和授权范围不变。支持此扩展的客户端读取明确关联后建立物理设备目录；不支持此扩展的旧客户端仍可能展示两项主体。未关联的纯远控设备与纯穿透设备继续独立展示。

## 部署边界

必须实际部署包含迁移 026 与上述路由的服务端后，关联才能持久保存并被其他桌面、移动或网页客户端读取。仅修改或安装本地桌面客户端不能更新远端服务器；旧服务器缺少这些接口时，本机已验证的精确关联只能作为兼容处理，不能声称服务器目录或跨端计数已经统一。网页和移动端也需要使用该关联协议才能统一展示。

升级保留已有 GUI/background UUID、账号授权规则、后台凭据、远控签名与服务配置。现有双主体记录通过明确 link 请求关联，不按名称批量合并，也不自动撤销其中一项。

Web 设备管理先完整读取账号主体分页、关联及绑定，再按物理设备筛选、分组与分页。只在扩展接口返回 404 时进入无关联兼容状态，认证失败和网络失败不会被当成空目录。普通移除走账号原子撤权、保留服务；管理员全部设备单独展示，永久删除明确提示逐项完成及部分失败后的刷新核对。
