# 当前测试说明

Home Tunnel 服务端处于内部测试阶段。使用具体提交 SHA 和产物校验值识别测试输入，不以较大的版本编号推断稳定性。

## 验证重点

- 配置生成、源码构建、HTTPS 入口和首次管理员改密。
- 普通用户的设备与连接隔离，以及管理员端口分配。
- HTTP 连接的创建、编辑、暂停、恢复和错误反馈。
- 表单草稿、字段校验、主题语言与响应式导航。
- 客户端断线、授权撤销、TCP / UDP 与备份恢复。

详细界面场景见 [UI_TESTING.md](UI_TESTING.md)，整体联调流程见[项目测试指南](https://github.com/ZHanry/home-tunnel/blob/main/docs/TESTING.md)。

## 构建与反馈

当前从 [README](../README.md) 的源码构建入口开始。
准备分发测试包时按 [RELEASING.md](RELEASING.md) 使用预发布流程。
反馈附服务端与客户端的提交、平台、操作步骤及脱敏后的错误；真实环境测试范围应单独记录。
