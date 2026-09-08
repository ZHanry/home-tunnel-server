# 开发记录

## Unreleased · 内部测试

- 当前仓库负责API、Web 控制台、网关与服务端部署。
- 统一开发文档、源码构建入口和内部测试状态。
- 自动化检查与真实环境反馈共同用于后续功能完善。

数字版本与已有标签用于识别内部构建。项目尚未建立正式稳定版本和长期支持政策。
后续用户可见变化在这里记录，并注明影响到的接口、配置和测试步骤。


## 5.0.1 · Security test build

- Bound Bearer header parsing and added public/API, password-change and DNS-verification rate limits.
- Replaced substring host matching with parsed host comparison.
- FRPS builds use reviewed locks for go-ntlmssp v0.1.1 (CVE-2026-32952).
- Security CI now checks open CodeQL findings after analysis.
