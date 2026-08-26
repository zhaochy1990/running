# Approve UX（Phase 4–6：批准并回写确认项目）

用法：`/approve-ux {filename1} [filename2] [filename3] ...`，每个 `{filename}` 是**已下载到本地、且用户已在浏览器审阅通过**的 HTML artifact（相对 `src/stitch_design/`，如 `artifacts/9170…_app-shell-side-drawer-open.html`，或只给裸文件名）。支持一次传入多个文件，批量走批准 + 确认项目重建流程。

本命令只负责审批之后的三段：**Phase 4 标记 approved → Phase 5 确认项目重建 → Phase 6 回读验证**。Phase 1–3（候选生成、下载、报告）不在此命令内 —— 用户调用本命令即表明已审阅通过、想要批准并同步到正式项目。

- 权威细则以 `src/stitch_design/AGENTS.md` 为准；项目 / 设计系统 ID 一律读 `src/stitch_design/stitch.config.json`，不硬编码。
- 候选项目 `STRIDE · Mobile`（当前 `12727163079393064568`）；确认项目 `Stride Mobile Confirmed · Raycast`（当前 `7939736180256612039`）。
- 凭据纪律：不输出 / 记录 / 提交 `STITCH_API_KEY` 等凭据值。

## Step 0 —— 解析输入并定位所有记录

1. 从 `$ARGUMENTS` 按空白拆分出多个文件名。裸文件名或相对路径都先按 `src/stitch_design/artifacts/{filename}` 解析；解析不到再按 `src/stitch_design/{filename}` 兜底；任何一个找不到就报错停止，请用户先跑 Phase 2 `export` 或给出正确文件名。
2. 读取 `src/stitch_design/artifacts/manifest.json`，按每条的 `html` 字段（或文件名前缀 `screenId`）定位对应记录。
3. 核对所有记录存在；任何一个不存在则报错停止。对已是 `approved` + `confirmedVerified` 的记录，在 summary 中标注"已批准已确认"，后续流程跳过（除非本地 hash 已变，则恢复待批准状态重新走）。

## Phase 4 —— 计算 SHA-256，确认后批量标记 approved

1. 为每个文件计算 SHA-256：

```bash
shasum -a 256 src/stitch_design/artifacts/{filename1} src/stitch_design/artifacts/{filename2} ...
```

2. 向用户展示一张总表：**候选 screen ID、screen 名称/标题、本地 HTML 路径、SHA-256、当前状态**（未批准 / 已批准未确认 / 已批准已确认 / hash 变化需重批）。
3. **批准 gate（HARD）**：写确认项目是不可逆的对齐动作，必须等用户确认 —— 向用户明确提问"确认批准以上 {N} 个 artifact 的 hash 并重建到确认项目 `Stride Mobile Confirmed · Raycast`？"。用户确认前不得修改 manifest、不得触碰确认项目。
4. 用户确认后，批量编辑 manifest 中对应记录：`status: "approved"`、`approvedArtifactSha256`（= 展示并获批准的 hash）、`approvedAt`（UTC ISO）；清除旧的 `confirmedProjectId` / `confirmedScreenId` / `confirmedAt` / `confirmedVerified`。
5. 若某条记录此前已是 approved 但本地文件 hash 已变 → 批准失效，按上述重新确认后覆盖，不得静默沿用旧批准。

## Phase 5 —— 在确认项目高保真重建（仅经 Stitch MCP，逐个执行）

CLI 的写命令（`generate/edit/variants/publish`）经 `requireCandidateProject` 强制只写候选项目，**没有写确认项目的 CLI 路径**；确认项目重建走 Stitch MCP 工具。

1. 重建前若 Foundation 有变更，先跑 `cd src/stitch_design && source "$HOME/.zshrc" && npm run stitch -- update-design-system`（同步候选 + 确认两套 design system），任一步失败必须先修复。
2. 对每一条待重建记录逐个执行：
   1. 重新计算本地文件 SHA-256，必须与 manifest 记录的获批值**严格匹配**；不匹配即跳过本条并报告（hash 变化 = 批准失效，重新走批准），不影响其它条目继续。
   2. 用 `mcp__stitch__generate_screen_from_text` 在确认项目重建：`projectId: <确认项目 ID>`、`designSystem: assets/<confirmedDesignSystemId>`、`deviceType: MOBILE`，prompt 由对应 `briefs/<brief>.md` + approved HTML 的文案 / 结构 / 视觉规格构成（Stitch SDK / MCP 不支持跨项目复制或直接导入 HTML，故按同一设计系统 + 完整 artifact 规格高保真重建）。
   3. 若确认项目已有同名 screen 且只是需微调，用 `mcp__stitch__edit_screens`；无现成基准才 `generate`。
   4. Stitch 返回异步事件但无 artifact 时，用 `get_screen` 重新获取，不得把未验证的 session 当完成。
3. 单条失败不中止整批；全部处理完后在 Phase 6 汇总。

## Phase 6 —— 批量回读验证 + 记录 + 汇总报告

1. 对每一条已重建的记录，`mcp__stitch__get_screen` 回读确认项目中的新 screen，核对**项目 ID、screen ID、标题、文案、结构和视觉方向**与已批准 artifact 一致。
2. 验证通过后写回 manifest：`confirmedProjectId`、`confirmedScreenId`、`confirmedAt`、`confirmedVerified: true`；验证失败则记录失败原因，不写 confirmed 字段。
3. 向用户输出一张汇总表，每行包含：候选 screen ID、screen 名称、确认 screen ID、本地 HTML、状态（已批准已验证 / 已批准待验证 / hash 失效 / 失败原因）。
4. 若有任何条目失败或跳过，在汇总末尾单独列出需人工跟进的条目。

## 完成定义

manifest 中所有目标记录的 approved 与 confirmed 字段完整、确认项目回读验证通过、汇总结果已报告用户。任何一条缺失或失败，都必须在汇总中明确标出，不得声称"全部完成"。

## 失效与归档规则

- 候选 HTML 的 SHA-256 变化即批准失效：恢复未批准状态、重新走批准，**批准前不得在确认项目创建或更新 screen**。
- 不得原地覆盖已批准 artifact；`artifacts/` 只提交 manifest 中 `approved` 的 canonical HTML。
