# HomeDesk 暖居 Web 改版验收

本次基于 `866e0cb`，在 `codex/hearth-web-ui` 分支修改管理台表现层。
开发始于 2026-10-06，验收于 2026-10-07 完成。当前阶段是本地验收与截图确认；尚未部署。

## 改版内容

浅色使用暖灰底、白色卡片、陶土色主操作，深色使用暖黑底与橙色主操作。
颜色以 HomeDesk 客户端最终主题值为准，统一中文字体、数字等宽、边框、间距、按钮、表单和状态颜色。
产品显示名称为 HomeDesk；官方代码仓库和软件下载目标仍指向原项目。

总览移除宣传横幅与重复的快速开始，保留真实指标、流量排行和组件健康信息。
桌面侧栏宽 248px，内容容器最大宽 1400px（含内边距），超宽屏居中；手机使用底部导航。
内网穿透补齐五列表头，与行单元格共用栅格，保留搜索、用户筛选、选择、批量动作、分页与原有操作。
暂停连接统一显示“已暂停”；设备使用“在线/离线”。同步状态与部署域名显示在页头。

九个管理页面、登录、四步发布向导、编辑/详情/删除确认、用户策略、设备标签、密码、双重验证、接入码、一次性密码展示、空态、错误态及 Toast 均沿用同一主题。
远控画布保留适合查看屏幕的深色背景，外围控件接入暖居 token，未改远控协议或鉴权流程。
中文和英文模式均保留，新文案补齐翻译。静态资源版本统一为 `10.1.0-hearth.1`，用于更新浏览器缓存。

## 修改文件

| 文件（仓库内相对路径） | 内容 |
| --- | --- |
| `control-center/public/console.css` | 浅深 token、基础组件颜色与字体。 |
| `control-center/public/prototype-theme.css` | 暖居布局与全站表现层覆盖。 |
| `control-center/public/remote.css` | 远控外围颜色变量与弹出窗口高度。 |
| `control-center/public/index.html` | 品牌、导航、页头、图标与资源缓存版本。 |
| `control-center/public/Hearth.svg` | 内联房屋图形对应的 favicon。 |
| `control-center/public/app.js` | 总览布局、页头信息、品牌文案与资源导入版本。 |
| `control-center/public/modules/connections.js` | 带列标题的列表模板。 |
| `control-center/public/modules/devices.js` | 设备状态徽标。 |
| `control-center/public/modules/format.js` | 状态展示文案。 |
| `control-center/public/modules/locale.js` | 品牌、新文案翻译与浏览器主题颜色。 |
| `control-center/public/modules/api.js` | 仅更新 locale 资源导入版本。 |
| `control-center/public/modules/tunnel-wizard.js` | 仅更新 locale 资源导入版本。 |
| `control-center/browser-tests/console.spec.mjs` | 总览入口及品牌图标断言适配。 |
| `control-center/browser-tests/ui-polish.spec.mjs` | 暖居 token、宽屏与列表布局断言适配。 |
| `control-center/browser-tests/hearth-layout.spec.mjs` | 尺寸矩阵、截图、几何断言与弹窗补查。 |
| `control-center/src/public.test.ts` | 仅更新网页品牌断言，没有修改后端实现。 |
| `docs/HEARTH_WEB_ACCEPTANCE_20261006.md` | 本记录。 |

## 实际检查

在 Control Center 使用 Node.js 24.19.0、pnpm 11.21.0 与 Playwright 1.58.2/Chromium 执行。

| 检查 | 结果 |
| --- | --- |
| `pnpm run check` | 通过。 |
| `pnpm run lint` | 通过，包含 69 个工作流 shell 块校验。 |
| `pnpm run format:check` | 通过。 |
| `pnpm run build` | 通过。 |
| `pnpm test` | 118 个编译后单元用例与 59 个脚本用例通过，0 失败；SQLite 集成检查通过。 |
| `pnpm run test:browser` | 116 通过，0 失败（102 既有用例、10 个页面矩阵用例、4 个弹窗矩阵用例）。 |
| API 规格生成检查 | 135 HTTP operations、64 shared schemas，一致。 |
| 页面几何检查 | 36,394 项，0 失败。 |
| 弹窗及补充状态几何检查 | 5,072 项，0 失败。 |
| 合计几何检查 | 41,466 项，0 失败。 |
| 截图 | 130 张页面全页图、112 张弹窗及补充状态图，共 242 张。 |

页面矩阵为浅色/深色 × 1280/1440/1920/2560/390px，覆盖九页、登录、向导第一步、远控与更新的错误态。
弹窗矩阵为浅色/深色 × 1920/390px，包含后续三个向导步骤、常用管理/安全弹窗、编辑窗口首尾、远控身份验证窗口、Toast 与设备空态。
几何脚本检查整页无横向溢出、文字边界与文字重叠、页头与整行面板边缘、表头/单元格 x 坐标、同排控件高度，容差 1px。
这些是 DOM 几何断言，不是与设计效果图逐像素比对；不将未显示或被固定导航遮挡的内容误算作可见文字。

所有交付截图已按原尺寸审阅。两张 8691px 高的手机审计全页图使用不缩放的裁切条审阅；弹窗使用不缩放的原图拼版审阅。
手机长截图中的固定底栏位于首次视口底部，这是全页截图的呈现方式；另提供手机视口截图供确认实际布局。

本机 Git Bash 安装路径与工作流校验脚本写死的路径不同，使用 ignored 的本地 preload 适配 spawnSync 路径，仍实际执行原 Bash `-n` 校验，未改仓库校验脚本。
工具、依赖安装产物、日志和图片位于 ignored 目录，不入源码提交。

## 截图与证据

本地证据根目录：`outputs/hearth-web-20261006/`。

- `screenshots/<theme>-<width>/` 保存页面 PNG 与逐页 `geometry.json`。
- `dialogs/<theme>-<width>/` 保存弹窗 PNG、手机视口图与 `geometry.json`。
- `review-crops/` 与 `review-originals/` 保存原尺寸审阅素材，没有替换原始交付 PNG。
- `logs/` 保存检查、格式、编译、单元及完整浏览器回归日志。
- `acceptance-summary.json` 保存最终几何统计。
- `DEPLOYMENT_PLAN.md` 保存基线、待执行步骤与回滚计划。

## 冻结范围与测试数据

Server 仍为 10.1.0，API 契约仍为 1.5.0。`contracts/`、`compatibility.json`、OpenAPI/schema、数据库迁移、依赖及锁文件均未修改；traffic-gateway 与部署配置未修改。
没有新增接口、小时趋势图、未经接口支持的状态筛选、外部字体或 CDN。
API 请求、会话和鉴权实现均未修改；`src/` 唯一改动是公开网页品牌测试正则。

截图使用现有 `ui-preview.mjs` 示例数据。上游预览未覆盖远控/更新正常接口，因此这些正常态由测试层使用已有设备样例和公开版本数据补齐，同时保留原始错误态截图。
双重验证确认与远控身份验证窗口使用明确的合成测试响应；一次性密码沿用预览数据。这些均是视觉/交互检查，不能计作真实联网远控、生产 MFA 或家庭服务可用性验证。
本轮未执行 Safari/Firefox、真实手机与不同操作系统字体渲染矩阵，也未执行正式发布门禁或线上改版验收。

## 部署状态

用户明确要求先确认截图。因此尚未构建或替换线上镜像，尚无新 digest 与此次实际备份路径。
此前只读核验确认现有 Control Center 健康，Server 10.1.0/API 1.5.0。
确认后仅以现有不可变 Control Center 镜像为基础替换 `/app/public`，后端字节保持原镜像；先备份 Compose 与 SQLite 一致性快照，再只重建 Control Center。
其它容器保持原状，以容器 ID 前后比较验证；实际登录、静态缓存、健康及版本检查放在部署后执行并单独记录。
这属于 HomeDesk 私有 UI 定制候选，不覆盖官方 stable 标签，也不冒充新的官方 Release。
