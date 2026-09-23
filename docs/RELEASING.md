# 发布流程

正式版本使用 `vX.Y.Z` 标签。8.0.0 将四个仓库与自有 Agent 统一版本，各组件独立构建，FRP 保留其第三方版本。源码版本与标签必须一致，`compatibility.json` 的阶段设为 `public-release`。

1. 提交代码到 `main`，等待 Quality Gate、CodeQL 和 Secret scan 成功。
2. 在已通过检查的提交上创建版本标签。
3. 工作流构建完整安装包，运行组件检查，验证签名与产物身份。
4. 服务端 Release 保存部署包、契约、镜像摘要、联调报告、校验清单及其 Sigstore bundle。镜像的 SBOM 与构建证明以 OCI attestation 保存在固定的 GHCR 镜像摘要上；Actions 附件提供额外副本。不能在签名后重写或删减清单。
5. 下载正式发布的安装文件，检查版本、签名与启动情况。

普通用户下载入口指向 Android `.apk`，桌面 `.exe` / `.zip` 或 Linux / macOS `.tar.gz`，服务端部署 `.tar.gz` 与 `compose.release.yaml`。Android `.aab` 和所有验证证据也在 Release 中持久保留。校验清单覆盖交付物和证据；APK 的 SHA-256 另外写入发布说明。项目入口仓库发布版本说明和发布清单并链接三个组件。

Android 沿用已有发行签名。Windows/macOS 的实际签名状态以对应产物报告为准；缺少证书时明确标注未签名，不能把版本号当作签名或平台验收证明。签名和公证流程已接入，半配置会阻止发布。API 1.2 契约在 main 检查通过后固定于不可改写的 `api-v1.2.0`；保留历史 `api-v1.0.0`、`api-v1.1.0` 和候选标签。跨组件改动必须验证权限、设备隔离及兼容性。

先冻结契约，再发布客户端并下载实际 Linux 8.0.0 包计算 SHA-256，然后更新服务端 `tests/client-baseline.json`，通过 amd64/arm64 发行联调后发布服务端。在真实 8.0.0 附件可下载之前，保留当前真实 7.0.0 基线，禁止填写预估摘要。契约标签和产品标签可以对应不同提交，但冻结的协议内容不可漂移。最后更新项目入口的 `releases.json`、网站副本和下载说明，使所有链接对应实际正式产物。

Windows 客户端继续使用两阶段发布：标签构建保留原始候选附件，操作者对其中的最终 worker 完成原生验收后，使用原构建 run ID 和验收报告启动发布。正式版本也必须通过原文件摘要、源提交、安装卸载、反病毒扫描及失联后两秒输入释放检查，不得重建文件替换已验收产物。

从 Release 的 `image-control-center.json` / `image-traffic-gateway.json` 读取 `image`
与 `digest`，组成 `IMAGE@sha256:...` 后查看各架构的持久证明：

```sh
docker buildx imagetools inspect 'IMAGE@sha256:...' --format '{{json .SBOM}}'
docker buildx imagetools inspect 'IMAGE@sha256:...' --format '{{json .Provenance}}'
```

Windows/Android 的 SPDX 文件直接保存为各自 Release 附件；服务端镜像的 SPDX 与
SLSA 证明跟随 OCI 镜像索引保留。它们均不依赖 90 天后可能过期的 Actions 附件。
