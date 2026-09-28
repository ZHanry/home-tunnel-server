# 服务端候选构建与发行

四个仓库与自有 Agent 协调升级到 10.0.0，FRP 保留独立版本。源码版本字段已为 10.0.0，`compatibility.json` 将 `api-v1.4.0` 标记为冻结；版本字段和开发测试记录不代表正式版本已通过验收。最终验收前冻结源码、版本、协议和依赖；改变交付物字节后必须生成新候选并重测。正式版本使用 `vX.Y.Z` 标签，源码版本与标签必须一致，`compatibility.json` 的阶段设为 `public-release`。

1. 在待测分支固定源码提交，完成 Quality Gate、CodeQL 和 Secret scan。
2. 构建并封存未打产品标签的候选，记录 run/attempt、artifact ID、ZIP 摘要和全部镜像摘要。
3. 下载原文件，完成本地虚拟机、Gemini 全界面审核、升级回退和长期稳定性验收，绑定四仓批次及原始证据。
4. 全部门槛通过后，将已验收源码归入 `main`，正式发布同一批文件，不重建、重新签名或重新封装替代已验收制品。
5. 核对正式 Release、版本、摘要和下载链接后清理开发分支。保留历史产品与协议标签。

服务端 Release 保存部署包、契约、镜像摘要、联调报告、校验清单及其 Sigstore bundle。镜像的 SBOM 与构建证明以 OCI attestation 保存在固定的 GHCR 镜像摘要上；Actions 附件提供额外副本。不能在签名后重写或删减清单。

普通用户下载入口指向 Android `.apk`，桌面 `.exe` / `.zip` 或 Linux / macOS `.tar.gz`，服务端部署 `.tar.gz` 与 `compose.release.yaml`。Android `.aab` 和所有验证证据也在 Release 中持久保留。校验清单覆盖交付物和证据；APK 的 SHA-256 另外写入发布说明。项目入口仓库发布版本说明和发布清单并链接三个组件。

Android 沿用原包名与已有发行签名，递增 `versionCode`，按 ABI 记录实际运行覆盖。Windows/macOS 的实际签名状态以对应产物报告为准；缺少证书时明确标注未签名，不能把版本号当作签名或平台验收证明。签名和公证流程已接入，半配置会阻止发布。REST 路径继续使用 `/api/v1`；API 1.4 完成跨组件验证后固定于不可改写的 `api-v1.4.0`，消费者导入相同来源的契约、测试向量和摘要锁。正式发布拒绝草案。跨组件改动必须验证权限、设备隔离及兼容性。

先冻结契约，按客户端/共享 SDK → Android 与服务端 → 入口仓库顺序发行。更新服务端 `tests/client-baseline.json` 时，必须先下载并验证真实客户端附件的 SHA-256；禁止填写预估摘要。通过 amd64/arm64 发行联调和本地虚拟机验收后发布服务端。契约标签和产品标签可以对应不同提交，但冻结的协议内容不可漂移。最后更新项目入口的 `releases.json`、网站副本和下载说明，使所有链接对应实际正式产物。

服务端稳定版不通过推送 `vX.Y.Z` 标签来构建。`release.yml` 对稳定标签在 metadata 失败，镜像作业不会运行，因此不会在验收前重建最终镜像。候选构建使用源码里的稳定版本号，不把版本改写成 rc，也不创建公开标签。镜像引用是 `sha-<提交>-<run id>` 加上不可变 digest；`compose.release.yaml` 只记录 `image@digest`。

候选入口是默认分支上已经登记的 `ci.yml` `workflow_dispatch`，输入 `build_candidate=true`。它先完成本次提交的 Quality Gate，并要求同一提交已有成功的 CodeQL 与 Secret scan。这两个安全工作流在 `main` 上已有 `workflow_dispatch`。候选作业单独持有 packages、id-token 与 attestations 权限；pull request 不满足 `workflow_dispatch` 条件，不会拿到这些权限。新的 `server-candidate.yml` 只有 `workflow_call`，本身不能被调度。`publish-stable.yml` 是新文件，在进入默认分支之前也不能被调度。在把这三份工作流文件送到 `main` 之前，不要把开发分支上的 `workflow_dispatch` 当成已经可用的入口。

正式发布只接受该候选 run 的原始字节。`publish-stable.yml` 用 GitHub API 核对 run 属于本仓库、调用方是 `ci.yml`、事件是 `workflow_dispatch`、结论成功、head SHA 与 artifact digest 一致，并用 `server-candidate.yml` 的原始 Sigstore 身份验证校验清单和镜像。清单里的 SHA 只在与 API 一致时采用。验收通过后另行签 `server-acceptance.SHA256SUMS.txt`，不覆盖 `SHA256SUMS.txt.sigstore.json`。验收必须包含服务端、Web UI、迁移、备份、网络、长期稳定性记录，以及与聚合仓库相同的四仓批次和 12 项门禁；缺项、未跑、失败、过期或不匹配都失败。发布脚本不生成通过记录。目标标签或附件已存在时拒绝创建。发布时源码版本必须是 10.0.0，且 `api-v1.4.0` 已在该提交标记为冻结。预发布标签仍走原门禁。历史版本标签和 `api-v1.3.0` 及更早契约标签保持不变。

Windows 客户端采用未打标签候选：在 `release.yml` dispatch 设置 `candidate=true` 和完整源码 `revision`，构建原始候选附件。完成最终 worker、安装包和全部远控验收后，发布器使用原 run ID、artifact ID/摘要及独立验收收据发布同一批文件。正式版本必须通过原文件摘要、源提交、安装卸载、反病毒扫描及失联后两秒输入释放检查。24 小时测试后对原字节执行独立 Defender 复扫，不修改原始扫描记录。详见[客户端发行流程](https://github.com/ZHanry/home-tunnel-client/blob/main/docs/RELEASING.md)。

从 Release 的 `image-control-center.json` / `image-traffic-gateway.json` 读取 `image`
与 `digest`，组成 `IMAGE@sha256:...` 后查看各架构的持久证明：

```sh
docker buildx imagetools inspect 'IMAGE@sha256:...' --format '{{json .SBOM}}'
docker buildx imagetools inspect 'IMAGE@sha256:...' --format '{{json .Provenance}}'
```

Windows/Android 的 SPDX 文件直接保存为各自 Release 附件；服务端镜像的 SPDX 与
SLSA 证明跟随 OCI 镜像索引保留。它们均不依赖 90 天后可能过期的 Actions 附件。
