# AGENTS.md

本文件约束 `src/stitch_design/` 下的所有 Stitch 手机端设计工作。

## 设计源

- Stitch 项目 `STRIDE · Mobile`（`12727163079393064568`）是候选设计与迭代项目。
- Stitch 项目 `Stride Mobile Confirmed`（`12356313034084557001`）只保存由用户已批准 artifact 重建并验证的 screen。
- Design System `Stride Mobile`（`8fe8bdef08b841bd8de2b5c32ad4b772`）是正式视觉基线。
- 产品范围、导航和页面状态以 `spec/app_feature.md` 为准。
- 本地 HTML 和 manifest 是审阅快照，不得代替 Stitch 中的正式设计。
- 不手改导出的 HTML 作为最终设计；需要修改时必须通过 Stitch SDK `edit` 或 `variants` 回写 Stitch。

## 认证

- Stitch 凭据来自 `STITCH_API_KEY`，当前配置在 `~/.zshrc`。
- 每条独立 Stitch 命令都先执行 `source "$HOME/.zshrc"`，不能假定前一次 shell 的环境会被继承。
- 不输出、记录、提交或转述 API key、access token 等凭据值。
- `.env` 只能用于本地覆盖，禁止提交。

## 开始设计前

1. 阅读 `spec/app_feature.md` 中对应模块和全局状态要求。
2. 阅读 `prompts/foundation.md`、`design-system.json` 和相关 `briefs/*.md`。
3. 运行 `npm run stitch -- screens`，先检查已有页面，避免重复生成。
4. 优先选择职责相同的现有 screen 做 `edit`；只有没有合适基准时才使用 `generate`。
5. 纯视觉方向探索使用 `variants`，不要把轻微差异当成多个正式页面。

## 页面 Brief

- 每个页面或关键状态都在 `briefs/` 下保留 Markdown brief。
- Brief 必须声明 route、产品状态、用户目标、必要内容、操作、导航、约束和验收项。
- 用户文案使用简体中文；标准跑步单位可保留 `km`、`/km`、`bpm`、`min`。
- 正式底部导航固定为 `跑者 / 训练 / 数据 / 教练`；`发现` 和个人中心位于侧边菜单。
- STRIDE 主色固定为 `#1FAD5B`，不得重新引入 `#00E676`。

## 生成与编辑

常用命令：

```bash
source "$HOME/.zshrc" && npm run stitch -- generate briefs/<brief>.md --slug <slug>
source "$HOME/.zshrc" && npm run stitch -- edit <screen-id> briefs/<brief>.md --slug <slug>
source "$HOME/.zshrc" && npm run stitch -- variants <screen-id> briefs/<brief>.md --count 3 --range EXPLORE
```

- `generate`、`edit` 和 `variants` 默认必须导出 artifact；正式工作不得传 `--no-export`。
- Stitch 返回异步事件但没有 artifact 时，使用 `get_screen`/`export` 重新获取；不得把未验证的 session 当成完成。
- 如果候选 screen 可按 ID 获取但未出现在候选项目画布，审阅通过后可用 `publish` 将最终 HTML 创建为候选项目 screen instance；确认项目仍必须遵守下方重建流程。

## 双项目审批流程（HARD）

每个正式 mobile screen 必须按以下顺序流转：

1. 只在候选项目 `12727163079393064568` 中生成、编辑和迭代 screen。
2. 将候选 screen 的 HTML artifact 下载到本地，完成视觉验证，并计算该文件的 SHA-256。
3. 向用户报告候选 screen ID、本地 HTML 路径、SHA-256 和验证结果，然后停止并等待用户明确批准这份 hash 对应的 artifact。
4. 用户明确批准后，将该 artifact 在 `artifacts/manifest.json` 中标记为 `approved` 并记录获批 SHA-256。重建前必须重新计算本地文件 SHA-256 并与 manifest 严格匹配；只有匹配时才可在确认项目 `12356313034084557001` 中按该 artifact 的文案、结构和视觉重建 screen。Stitch SDK/MCP 不支持跨项目复制或直接导入 HTML，因此使用同一设计系统和完整 artifact 规格高保真重建。
5. 回读确认项目中的新 screen，核对项目 ID、screen ID、标题、文案、结构和视觉方向；验证通过后将确认项目和 screen ID 写入 manifest，再向用户报告结果。

生成候选、自动检查、查看 artifact、提出修改意见都不构成人工批准。不得原地覆盖已批准 artifact；需要继续迭代时，先清除 manifest 中的批准和确认项目字段，再导出新候选。候选 HTML 的 SHA-256 发生变化后，之前的批准立即失效，manifest 必须恢复为未批准状态，并重新完成视觉验证和人工批准。批准前不得在确认项目中创建或更新 screen。

## 本地下载（HARD）

每个设计完成后，必须下载到本地：

- HTML：`artifacts/{screen_id}_{slug}.html`
- 索引：更新 `artifacts/manifest.json`

示例：

```bash
source "$HOME/.zshrc" && npm run stitch -- export <screen-id> --slug <slug>
```

下载规则：

- 只下载 HTML，不调用或保存 Stitch 截图，不在 `artifacts/` 创建 PNG、JPEG 或 WebP。
- HTML 下载失败时任务不算完成。
- `manifest.json` 必须记录候选项目和 screen ID、确认项目和 screen ID、slug、页面状态、brief、生成血缘、本地 HTML、审阅状态、获批 artifact 的 SHA-256，以及确认项目重建验证状态；未批准项不得填写获批 hash 或确认项目字段。
- 比选候选可以临时下载，但正式 manifest 只保留已采用页面；不要把失败探索标记为 approved。
- `artifacts/` 只保留 `manifest.json` 中标记为 `approved` 的 canonical HTML，并与 manifest 一起提交 Git。
- 候选、失败生成、逐次精修和重复 verify HTML 必须在提交前删除，不能进入正式归档。

## 视觉验证（HARD）

下载后必须进行两层检查：

1. 检查 HTML 可见文案与结构，确认页面职责、信息层级、导航、主色和状态正确。
2. 使用真实浏览器以 `390x844` viewport 渲染本地 HTML，检查首屏和滚动内容。

浏览器验证不得把图片写入 `artifacts/`。自动化确需截图时，只能在系统临时目录生成，审阅后删除，不纳入 manifest 或设计归档。

验收至少包括：

- 360px 和 390px 宽度下不横向溢出；
- 顶部、底部安全区正确；
- 主要触控目标至少 48 logical px；
- 状态不只依赖颜色；
- 数字使用等宽字体；
- 不出现 `发现` 底部 Tab、旧术语、旧绿色、玻璃效果或无关占位 CTA；
- 加载、空、错误、离线等适用状态有明确设计。

## 发布与收尾

1. 对最终 screen 再执行一次 `export`，验证可通过 ID 重新获取。
2. 完成双项目审批流程；只有用户批准的 artifact 才能在确认项目中重建。
3. 如果候选 screen 需要挂载候选项目画布，先确认 CLI 配置的项目 ID 是 `12727163079393064568`，再执行：

```bash
source "$HOME/.zshrc" && npm run stitch -- publish \
  artifacts/<screen-id>_<slug>.html \
  --title "<正式中文页面标题>" \
  --slug <slug>
```

4. 分别检查候选项目和确认项目，确认 screen 位于正确的项目清单中。
5. 运行 `npm run check` 和 `git diff --check`。
6. 向用户报告候选 screen ID、确认 screen ID、本地 HTML、页面状态和验证结果。

没有完成本地 HTML 下载、manifest 更新和 390×844 浏览器审阅，不得声称页面设计完成。
