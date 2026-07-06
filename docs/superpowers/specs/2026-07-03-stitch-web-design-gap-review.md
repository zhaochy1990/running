# Stitch Web Design Gap Review

**日期**: 2026-07-03  
**范围**: STRIDE Web 端 Stitch 设计稿检查、补齐清单与逐屏 Review 标准  
**状态**: Gap Review / 待 Stitch 补齐  
**Stitch 项目**: `STRIDE · Web` (`9898197682875783129`)  
**主规范**: `frontend/DESIGN.md`  
**决策记录**: `docs/superpowers/specs/2026-07-03-stitch-web-master-plan-workspace-rules.md`

## 1. Review 输入

本次 Review 只面向 Web 端设计稿，不针对现有前端代码做设计，也不写实现代码。

证据来源:

- Stitch 当前项目页面清单: `C:/tmp/stitch-existing-review/screens-current.json`
- Web 桌面截图: `C:/tmp/stitch-existing-review/current-web/screenshots/*.png`
- Web 桌面 HTML: `C:/tmp/stitch-existing-review/current-web/html/*.html`
- Web 桌面文本抽取: `C:/tmp/stitch-existing-review/current-web/text/*.txt`
- Web 桌面下载摘要: `C:/tmp/stitch-existing-review/current-web/desktop-download-summary.json`

当前项目共有 43 张已下载的 Desktop Web 页面证据。Master Plan 相关页面覆盖较完整；Weekly Plan 调整与日常问答是主要缺口。

## 2. 核心判断

| 核心场景 | 当前覆盖 | 结论 | 处理方式 |
| --- | --- | --- | --- |
| 新用户生成 Master Plan | 信息收集、追问、信息确认、生成中、Plan Review、启用成功基本齐全 | 流程已成型，但缺少生成完成待查看卡片；Plan Review 需要强化中栏 CTA 归属 | 保留主链路，微调 Plan Review，新增 Plan Ready |
| 老用户修改 Master Plan | 首页、当前计划调整、生成中、Diff Review、确认应用、成功、失败/无变化恢复状态基本齐全 | 是当前最完整的链路；需要收紧三栏中栏主工作区和右栏聊天职责 | 保留多数页面，微调调整入口和 Diff Review |
| 调整本周课表 | 仅有早期 AI 对话和审阅模式，缺少标准 Weekly Plan 工作区 | 不符合已确认的三栏规则，且缺少 Week Diff Review 闭环 | 重画/新增整条 Weekly Plan Web 链路 |
| 日常问答 | 只有泛化 AI 教练对话，没有基本指标、疲劳、伤病分流等高频状态 | 最大缺口；需要两栏 Coach Workspace 状态 | 新增日常问答页面组 |

## 3. 页面级覆盖矩阵

### 3.1 新用户生成 Master Plan

| 状态 | 现有页面证据 | Review 结论 | 处理 |
| --- | --- | --- | --- |
| 创建计划 / 信息收集 | `13_9a8e6956_创建赛季计划 - STRIDE Master Plan`，`09_88389455_STRIDE - 创建赛季计划`，`11_49c51e65_创建你的赛季计划 - STRIDE` | `13` 信息最完整，但更像表单工作区；仍可作为新用户两栏信息收集的基础。`09/11` 偏入口页，可降级为参考 | 保留 `13`，弱化 `09/11` 优先级 |
| Coach 结构化追问 | `05_81a893c1_Coach 评估 - STRIDE Master Plan`，`40_453e0646_还不能生成 Master Plan - STRIDE` | 结构化问题卡和缺失信息都已覆盖；`40` 很适合信息不足状态 | 保留 |
| 信息确认完毕 | `12_fd3d8646_创建赛季训练计划 - 信息确认完毕` | 能解释已收集信息和生成耗时，CTA 清楚 | 保留 |
| 生成中等待引导 | `24_f90fb3cd_生成赛季训练计划 - STRIDE Master Plan`，`39_734ad822_赛季推演中 - STRIDE` | `24` 更贴近规范，展示步骤、预计耗时、当前处理内容；`39` 风格偏旧且导航不统一 | 保留 `24`，`39` 降级为参考 |
| 生成完成待查看 | 无明确 Web 页面 | 规范要求不自动跳三栏，先显示完成卡片和 `查看计划` | 新增 |
| Plan Review | `17_2d825949_审阅赛季训练计划 - STRIDE`，`15_5a70dbf3_审阅修订后的赛季训练计划 - STRIDE` | 已有中栏计划与右侧 Coach 反馈雏形，但 `应用到计划` 与 `启用计划` 权重竞争，需要明确最终确认属于中栏 | 微调 |
| 启用成功 / Master Plan 首页 | `38_fb594958_赛季训练计划已启用 - STRIDE Master Plan`，`07_aea3def6_Master Plan Home - STRIDE` | 成功与首页都有，首页应只展示已启用计划，不混入 Plan Review | 保留 |

深度 Review:

- User Flow: 主链路基本顺畅，但生成完成后缺少“待查看”缓冲页，容易直接跳转到 Review 或让用户不知道生成已完成。
- IA: Intake、追问、生成中信息层级清楚；Plan Review 中计划内容和 Coach 反馈容易竞争。
- Visual Hierarchy: 生成中页面状态明显；Plan Review 的最终 CTA 需要更强中栏归属。
- Interaction: 结构化问题卡符合直觉；生成失败、信息不足已有覆盖；完成待查看恢复入口缺失。
- Consistency: Master Plan 术语和状态标签基本一致，部分旧页面英文导航和中文导航混用。
- Accessibility: 关键 CTA 文案明确；Diff / 待确认状态不能只靠颜色，需要文字标签继续保留。

### 3.2 老用户修改 Master Plan

| 状态 | 现有页面证据 | Review 结论 | 处理 |
| --- | --- | --- | --- |
| Master Plan 首页 | `01_3d868920_10 Master Plan Home - Active Entry`，`02_c0255847_10 Master Plan Home - Active Entry`，`07_aea3def6_Master Plan Home - STRIDE` | 已展示当前计划、目标赛事、阶段进度、版本历史、调整入口 | 保留 `07/01`，去重 |
| 点击调整计划后当前计划三栏 | `36_599584b3_调整赛季训练计划 - STRIDE Master Plan` | 符合“中栏先展示当前 Master Plan，右栏收集调整意图”的规则 | 微调 |
| 调整方案生成中 | `23_94aa25a2_生成调整方案 - STRIDE Master Plan` | 保留当前计划生效状态、进度、预计影响，方向正确 | 保留/微调 |
| Master Plan Diff Review | `16_39098a1f_审阅调整方案 - STRIDE Master Plan` | 有版本关系、变化摘要、当前/拟议对比、写操作审阅；需强化选中 diff affordance 和中栏主 CTA | 微调 |
| 确认应用 | `25_38bb748b_确认应用调整 - STRIDE Master Plan` | 二次确认、影响范围和设备同步提示清楚 | 保留 |
| 启用成功 | `32_4e631eb6_训练计划 _ 调整已应用 - STRIDE`，`33_54a22b89_训练计划 _ 调整已应用 - STRIDE` | 成功后展示新版生效和受影响周计划，符合规则 | 保留，后续去重 |
| 异常 / 恢复 | `19_a44eefe0_没有需要应用的变更`，`22_87f23c5f_生成没有完成`，`34_ea9e4161_调整流程恢复与确认`，`35_48619773_调整方案生成失败` | 异常状态覆盖充分，适合作为设计系统状态库 | 保留 |

深度 Review:

- User Flow: 从首页点击 `调整计划` 到三栏调整、生成、Diff、确认应用的闭环完整。
- IA: 当前计划、调整意图、预计影响、Diff Review 层级清楚；`36` 右栏与中栏信息密度偏高。
- Visual Hierarchy: `16` 的 Diff 内容足够突出，但主 CTA 应统一为中栏底部/右上固定操作，不应被右栏反馈按钮抢权重。
- Interaction: 用户可以通过右栏继续反馈或询问；中栏最终确认区只保留 `启用计划`。
- Consistency: Master Plan Diff 模式已较稳定，后续 Week Diff 应复用其结构但替换为周日历/训练项语义。
- Accessibility: 表格型 Diff 需要保证键盘可聚焦与状态文字标签；不能只用颜色区分新增/删除/修改。

### 3.3 调整本周课表

| 状态 | 现有页面证据 | Review 结论 | 处理 |
| --- | --- | --- | --- |
| 当前 Weekly Plan 首页 | 无明确 Web 页面；`03` 右侧有当前对象摘要 | 缺少独立本周课表首页，用户无法从已启用周计划进入 `调整本周` | 新增 |
| 点击调整本周后当前周计划三栏 | 无标准页面；`03_8b9ff2e9_AI 教练对话 - STRIDE` 混合聊天、当前对象和提案影响 | 不符合新规则。点击 `调整本周` 后应立即三栏，中栏展示当前 Weekly Plan，右栏 Coach Chat | 重画/新增 |
| 本周调整方案生成中 | 无标准页面；`18_408e555b_正在重算周计划` 是 Master Plan 调整后的周计划重算，不是用户调整本周 | 需要三栏生成态，中栏保留当前 Weekly Plan 并展示进度 | 新增 |
| Week Diff Review | `04_8d6555cf_AI 教练对话 — 审阅模式 - STRIDE` 有当前/拟议对比和 checklist | 方向接近，但布局不是规范三栏，右侧聊天和中栏 Review 职责不稳 | 重画/新增 |
| 本周调整启用成功 | 无明确页面 | 需要展示新版本周课表已生效、被移动/替换/删除训练、返回本周课表 | 新增 |
| 影响 Master Plan 升级提示 | 无明确页面 | Weekly Plan 调整可能影响阶段关键目标，需要提示但不自动切换 | 新增 |

深度 Review:

- User Flow: 当前页面不能完整支持从本周课表进入调整、生成 Diff、确认应用、返回本周课表的闭环。
- IA: `03/04` 的当前对象、提案和聊天混在一起，用户不容易判断自己是在聊天还是在确认写操作。
- Visual Hierarchy: Week Diff 应让“周一到周日的变化”成为视觉主角，而不是一段普通对话中的提案卡。
- Interaction: 需要支持单项询问 Coach 和右栏反馈；最终确认 CTA 必须在中栏，且只保留 `启用计划`。
- Consistency: 应复用 Master Plan Diff 的版本关系、变化摘要、写操作审阅，但内容模型改为周日历和训练项。
- Accessibility: 日历 Diff 不能仅用位置或颜色表达变化；每个训练项要有文字状态，如移动、替换、降强度、删除、新增。

### 3.4 日常问答

| 状态 | 现有页面证据 | Review 结论 | 处理 |
| --- | --- | --- | --- |
| 基本训练问题 | 无标准页面；`03` 泛化 Coach 对话可参考 | 缺少“最近练得怎么样 / 月跑量 / 平均配速”的两栏回答模板 | 新增 |
| 单次训练复盘 | 无标准页面 | 缺少“今天早上的节奏跑跑得怎么样”的回答模板 | 新增 |
| 疲劳 / 跑不动 | 无标准页面 | 缺少状态分流、短期建议、是否调整本周的确认 | 新增 |
| 伤病 / 跟腱疼 | 无标准页面 | 缺少风险分流、安全建议、非医疗诊断说明、是否临时调整本周 | 新增 |
| 从问答升级到 Weekly Plan | 无标准页面 | 需要先让用户理解将调整 Weekly Plan，确认后进入三栏 | 新增 |
| 从问答升级到 Master Plan | 无标准页面 | 需要先让用户理解将调整 Master Plan，确认后进入三栏 | 新增 |

深度 Review:

- User Flow: 目前缺少日常问答主线，用户只能从泛化 AI 教练页推断能力，不知道可以问哪些问题，也不知道何时会进入计划调整。
- IA: 两栏 Coach Workspace 应包含左侧计划摘要、近期训练入口、风险状态；右侧聚焦回答和可选下一步。
- Visual Hierarchy: 回答要先给结论，再给关键指标/风险，再给下一步；不要把所有数据卡等权堆叠。
- Interaction: 疲劳和疼痛不能直接改计划，必须先询问/分流；升级到三栏前要明确调整对象。
- Consistency: 日常问答的 CTA 文案应和计划调整入口一致，如 `调整本周课表`、`调整赛季训练计划`、`先继续问 Coach`。
- Accessibility: 风险提示必须使用图标+文字+说明，不只用红色；疼痛风险问题需要清楚可读的安全提示。

## 4. Stitch 补齐清单

### 4.1 需要微调的现有页面

| 现有页面 | 目标 | 编辑要点 |
| --- | --- | --- |
| `17_2d825949_审阅赛季训练计划 - STRIDE` | Master Plan / New User / Plan Review | 强化三栏结构；中栏为 Plan Review 主工作区；最终 CTA 只保留 `启用计划`；右栏只做解释、追问和反馈输入 |
| `36_599584b3_调整赛季训练计划 - STRIDE Master Plan` | Master Plan / Existing / Current Plan Adjust | 保持三栏；中栏突出当前计划，右栏突出 Coach 追问；减少预计影响与聊天的视觉竞争 |
| `16_39098a1f_审阅调整方案 - STRIDE Master Plan` | Master Plan / Existing / Diff Review | 强化版本关系、分组 Diff、选中项状态、主 CTA；右栏不放最终确认 |

### 4.2 需要新增的 Web 页面

| 新页面 | 布局 | 目的 |
| --- | --- | --- |
| `Master Plan / New User / Plan Ready` | 两栏 | 生成完成后显示完成卡片，用户点击 `查看计划` 才进入三栏 |
| `Weekly Plan / Active Home` | 非 Review 首页或两栏工作入口 | 展示已启用本周课表、周目标、总量、关键课，并提供 `调整本周` |
| `Weekly Plan / Current Week Adjust` | 三栏 | 点击 `调整本周` 后，中栏显示当前 Weekly Plan，右栏收集调整意图 |
| `Weekly Plan / Generating` | 三栏 | 保留当前周计划并展示生成本周调整方案进度 |
| `Weekly Plan / Week Diff Review` | 三栏 | 按周一到周日展示移动、替换、删除、降强度、新增，主 CTA `启用计划` |
| `Weekly Plan / Applied Success` | 非 Review 首页或成功页 | 展示本周新版本已生效、变化摘要、返回本周课表 |
| `Weekly Plan / Master Plan Impact Prompt` | 三栏 | 当本周调整影响阶段目标时，在中栏提示是否升级 Master Plan 调整 |
| `Coach Chat / Daily QA / Metrics` | 两栏 | 回答最近训练状态、月跑量、平均配速、完成率和下一步 |
| `Coach Chat / Daily QA / Tempo Review` | 两栏 | 复盘今天节奏跑质量，给出配速/心率/RPE/建议 |
| `Coach Chat / Daily QA / Fatigue` | 两栏 | 疲劳状态分流，给出 24-48 小时建议，询问是否调整本周 |
| `Coach Chat / Daily QA / Pain Triage` | 两栏 | 跟腱疼风险分流、安全建议、必要时就医提示，询问是否临时调整本周 |
| `Coach Chat / Escalation / To Weekly Plan` | 两栏到三栏前确认 | 说明将调整 Weekly Plan，用户确认后进入三栏 |
| `Coach Chat / Escalation / To Master Plan` | 两栏到三栏前确认 | 说明将调整 Master Plan，用户确认后进入三栏 |

## 5. 生成 / 编辑原则

后续使用 Stitch 生成或编辑页面时，遵守以下规则:

1. 使用项目 `9898197682875783129`。
2. 使用项目已有设计系统 `STRIDE Endurance Lab`。
3. 生成 prompt 只描述布局、内容和结构，不重复颜色、字体、圆角等设计系统 token。
4. Web 页面 device type 使用 `DESKTOP`。
5. Master Plan 已有页面优先微调，不从零重画。
6. Weekly Plan 和日常问答缺口优先新增，因为现有证据不足以支撑完整流程。
7. 每张新增/编辑后的页面都要下载 HTML 与 screenshot 到本地证据目录，并做逐维度 Review。

## 6. 下一步执行顺序

1. 先新增 `Master Plan / New User / Plan Ready`，补上新用户生成完成但未进入 Plan Review 的关键状态。
2. 微调 `17`、`36`、`16` 三张 Master Plan 关键 Review/调整页。
3. 新增 Weekly Plan 完整闭环: Active Home、Current Week Adjust、Generating、Week Diff Review、Applied Success、Master Plan Impact Prompt。
4. 新增日常问答页面组: Metrics、Tempo Review、Fatigue、Pain Triage、To Weekly Plan、To Master Plan。
5. 下载所有新增/编辑结果，并更新本文件的完成状态和逐屏 Review。
## 7. Stitch 补齐执行结果

本轮已在 Stitch 项目 `9898197682875783129` 中新增或微调 Web Desktop 设计稿，并下载 HTML / screenshot 到 `.stitch/designs/`。

### 7.1 新增页面

| 场景 | 页面 | Stitch Screen ID | 本地证据 |
| --- | --- | --- | --- |
| 新用户生成 Master Plan | Master Plan / New User / Plan Ready | `bd9af979092141458eac4d40ecdbc41e` | `frontend/design/1_bd9af979_master-plan-new-user-plan-ready.html` |
| Weekly Plan | Weekly Plan / Active Home | `ffed1fb24cb047bebdc4c39ccf57af2d` | `.stitch/designs/ffed1fb2_weekly-plan-active-home.html` |
| Weekly Plan | Weekly Plan / Current Week Adjust | `735104f996014e31af47852585c9db34` | `.stitch/designs/735104f9_weekly-plan-current-week-adjust.html` |
| Weekly Plan | Weekly Plan / Generating | `fc3154fbdfda4177819bb57c6cf61553` | `frontend/design/7_fc3154fb_weekly-plan-generating.html` |
| Weekly Plan | Weekly Plan / Week Diff Review | `5dbcbfd8ce2e4ab9860e1dbfd78c911c` | `.stitch/designs/5dbcbfd8_weekly-plan-week-diff-review.html` |
| Weekly Plan | Weekly Plan / Applied Success | `628f2302f50c4c9a905dd2fb4c20f974` | `.stitch/designs/628f2302_weekly-plan-applied-success.html` |
| Weekly Plan | Weekly Plan / Master Plan Impact Prompt | `790e76594b1c46d996af9a716db5f097` | `.stitch/designs/790e7659_weekly-plan-master-plan-impact-prompt.html` |
| 日常问答 | Coach Chat / Daily QA / Metrics | `2528d4fc288944d6b64f801f508e9ef3` | `.stitch/designs/2528d4fc_coach-chat-daily-qa-metrics.html` |
| 日常问答 | Coach Chat / Daily QA / Tempo Review | `b38464f3415f494a9046e3a180ba4d6c` | `.stitch/designs/b38464f3_coach-chat-daily-qa-tempo-review.html` |
| 日常问答 | Coach Chat / Daily QA / Fatigue | `d6fb130b7aac494aae7656c5bbeea744` | `.stitch/designs/d6fb130b_coach-chat-daily-qa-fatigue.html` |
| 日常问答 | Coach Chat / Daily QA / Pain Triage | `10f72afb27c94d41b84877255f38a454` | `.stitch/designs/10f72afb_coach-chat-daily-qa-pain-triage.html` |
| 日常问答升级 | Coach Chat / Escalation / To Weekly Plan | `dc63efc6300d41dbad7f8802e36e2386` | `.stitch/designs/dc63efc6_coach-chat-escalation-to-weekly-plan.html` |
| 日常问答升级 | Coach Chat / Escalation / To Master Plan | `3d256d01ba684194b5535c78963d42f7` | `.stitch/designs/3d256d01_coach-chat-escalation-to-master-plan.html` |

### 7.2 微调页面

| 场景 | 页面 | 新 Stitch Screen ID | 本地证据 |
| --- | --- | --- | --- |
| 新用户生成 Master Plan | Master Plan Plan Review refined | `cd1ed2f577cd453da406342acfe0387e` | `frontend/design/2_cd1ed2f5_master-plan-plan-review-refine.html` |
| 老用户修改 Master Plan | Current Master Plan Adjust refined | `59e3462e55f043d79109182c62657e52` | `.stitch/designs/59e3462e_master-plan-current-adjust-refine.html` |
| 老用户修改 Master Plan | Master Plan Diff Review refined | `6dbb06b8168a4feab03b58a395bc4af6` | `.stitch/designs/6dbb06b8_master-plan-diff-review-refine.html` |

## 8. 逐屏 Review

### 8.1 Master Plan / New User / Plan Ready

- User Flow: 生成完成后仍停留在两栏 Coach Workspace，避免自动跳转；用户通过 `查看计划` 主动进入三栏。
- IA: 左栏只承载产品导航和计划入口；右栏聊天流承载完成卡片、摘要，并在输入框上方显示创建进度。
- Visual Hierarchy: 完成卡片和主 CTA 清楚，`稍后查看` 为次级动作。
- Interaction: 支持用户离开后通过计划入口恢复；计划尚未启用的状态明确，进度仍在聊天输入框上方。
- Consistency: 遵循两栏规则，与新用户生成中页面连续。
- Accessibility: 状态和 CTA 均有文字说明，不依赖动画或颜色。

### 8.2 Master Plan Plan Review Refined

- User Flow: 用户从 Plan Ready 进入三栏后，可以在中栏审阅并确认启用；反馈仍通过右栏。
- IA: 左栏只保留产品导航，中栏为计划内容、阶段信息、风险监控和最终 CTA，右栏为 Coach，并在输入框上方显示审阅进度。
- Visual Hierarchy: `启用计划` 已归属中栏，且是唯一最终确认按钮。
- Interaction: 用户可以通过右栏继续解释、追问或补充反馈；不再提供并列决策按钮。
- Consistency: 与 Master Plan Diff Review 的三栏职责一致。
- Accessibility: 待确认状态、确认后影响和关键风险均有文字标签。

### 8.3 Current Master Plan Adjust Refined

- User Flow: 存量用户点击 `调整计划` 后立即看到三栏，且中栏不是空白，而是当前 Master Plan。
- IA: 中栏解释当前计划，右栏收集调整意图和追问。
- Visual Hierarchy: 当前计划优先，潜在影响预测降为右栏次级内容。
- Interaction: 信息不足时只收集和追问；`生成调整方案` 不等同应用。
- Consistency: 符合“当前计划保持生效，直到 Diff 被接受”的规则。
- Accessibility: 当前状态、版本和右侧输入框上方的调整进度均有文本说明。

### 8.4 Master Plan Diff Review Refined

- User Flow: 用户可以理解从 v1.2 到 v1.3 的变化，并在中栏接受、反馈或放弃。
- IA: Diff 按目标赛事、阶段排期、峰值跑量、恢复周、关键课、设备同步分组。
- Visual Hierarchy: 中栏为主决策区，右栏只解释被选中的变化。
- Interaction: 支持选中 Diff、询问 Coach，并通过右栏输入补充反馈。
- Consistency: 与 Weekly Diff Review 共享“版本关系 + 变化摘要 + 分组 Diff + 中栏 CTA”的模式。
- Accessibility: Diff 状态使用 `新增`、`删除`、`修改`、`受影响` 等文字标签。

### 8.5 Weekly Plan / Active Home

- User Flow: 用户可以从已启用本周课表查看周目标、训练安排并进入 `调整本周`。
- IA: 首页不混入 Review；清楚展示 active v7、周目标、七日计划和训练摘要。
- Visual Hierarchy: `调整本周` 是主要入口，但不制造 Plan Review 任务。
- Interaction: 提供进入 Master Plan、版本历史和调整入口。
- Consistency: 与 Master Plan 首页职责对应，但聚焦短周期周课表。
- Accessibility: 每天训练类型、状态、强度和备注均为文字可读。

### 8.6 Weekly Plan / Current Week Adjust

- User Flow: 点击 `调整本周` 后立即三栏，中栏显示当前 Weekly Plan，右栏收集意图。
- IA: 左栏只放上下文和导航，中栏为当前周计划，右栏为 Coach 追问，并在输入框上方显示调整进度。
- Visual Hierarchy: 当前周计划是主工作区，聊天作为辅助。
- Interaction: 结构化问题和 quick replies 能让用户直接回答约束。
- Consistency: 不出现空中栏，符合 Weekly Plan 三栏规则。
- Accessibility: 调整范围和当前计划仍生效都有文字说明。

### 8.7 Weekly Plan / Generating

- User Flow: Coach 信息足够后进入生成中，仍保持三栏，不出现空白中栏。
- IA: 中栏保留当前周计划、当前处理内容、预计耗时和影响预览；生成进度统一显示在右侧聊天输入框上方。
- Visual Hierarchy: 生成状态清楚，右栏只做等待引导和补充约束。
- Interaction: 用户可以稍后查看、取消生成或继续补充约束。
- Consistency: 与 Master Plan 生成等待态一致，但保留 Weekly Plan 当前对象。
- Accessibility: 生成中步骤有文字状态，不只靠动画。

### 8.8 Weekly Plan / Week Diff Review

- User Flow: 用户能看到 v7 到 v8 的变化，通过右栏反馈，或在中栏启用计划。
- IA: 周一到周日的变化是主结构，Master Plan 影响在中栏明确说明。
- Visual Hierarchy: `启用计划` 属于中栏，右栏只有解释和反馈入口。
- Interaction: Diff 项支持 `问 Coach` 与 `提出反馈`，便于携带上下文。
- Consistency: 复用 Master Plan Diff 模式，但内容模型变成周计划与训练项。
- Accessibility: 变化类型使用 `移动`、`替换`、`降强度`、`删除`、`保留` 等文字标签。

### 8.9 Weekly Plan / Applied Success

- User Flow: 用户确认后离开 Plan Review，看到 v8 已成为当前本周计划。
- IA: 成功页聚焦新版本、变化摘要、返回本周课表和版本归档。
- Visual Hierarchy: 成功状态和 `回到本周课表` 为主。
- Interaction: 支持查看变更详情或继续和 Coach 聊。
- Consistency: 不继续混入 Review 任务，符合成功后返回首页原则。
- Accessibility: 变更、同步状态、版本归档都有文字说明。

### 8.10 Weekly Plan / Master Plan Impact Prompt

- User Flow: 当本周调整可能影响阶段目标时，先提示影响，不自动切到 Master Plan。
- IA: 中栏保留 Weekly Diff 预览，并解释 P1 阶段目标受影响。
- Visual Hierarchy: 中栏最终确认区只保留 `启用计划`，避免把影响判断做成多按钮选择题。
- Interaction: 是否升级到 Master Plan 调整通过右栏 Coach 对话澄清，再进入相应调整流程。
- Consistency: 固化 Weekly Plan 与 Master Plan 的边界。
- Accessibility: 风险等级和完成率变化使用文字和数值说明。

### 8.11 Coach Chat / Daily QA / Metrics

- User Flow: 用户问训练状态时保持两栏，不进入 Review。
- IA: 左栏给计划和数据上下文，右栏先结论、再指标、再解释、再下一步。
- Visual Hierarchy: 关键指标卡可扫读，CTA 不强迫修改计划。
- Interaction: 用户可继续问、查看本周课表或选择调整本周。
- Consistency: 日常问答默认两栏，符合规则。
- Accessibility: 指标和结论均为文字表达。

### 8.12 Coach Chat / Daily QA / Tempo Review

- User Flow: 用户复盘单次节奏跑时停留在问答，不进入计划调整。
- IA: 左栏提供活动上下文，右栏展示完成质量、分段、心率漂移和建议。
- Visual Hierarchy: 先给结论，再给计划 vs 实际数据。
- Interaction: 可查看活动详情、调整本周恢复或继续按计划。
- Consistency: 与 Metrics 页面同属两栏 Coach Workspace。
- Accessibility: 分段表和指标文字可读。

### 8.13 Coach Chat / Daily QA / Fatigue

- User Flow: 用户说累时先状态分流，不直接修改计划。
- IA: 左栏显示疲劳信号，右栏结构化询问睡眠、酸痛、静息心率和疲劳程度。
- Visual Hierarchy: 短期建议和升级入口清楚。
- Interaction: 用户可观察、补充症状或进入 Weekly Plan 调整。
- Consistency: 疲劳属于日常问答，只有用户确认调整才升级。
- Accessibility: 风险信号和建议均为文字说明。

### 8.14 Coach Chat / Daily QA / Pain Triage

- User Flow: 用户说跟腱疼时进入风险分流，不把疼痛当普通训练反馈。
- IA: 左栏显示健康上下文，右栏收集疼痛位置、程度、持续时间和危险信号。
- Visual Hierarchy: 安全建议与非医疗诊断说明清楚。
- Interaction: 用户可临时调整本周训练、继续回答疼痛问题或查看健康记录。
- Consistency: 伤病默认两栏，短期避让才升级 Weekly Plan。
- Accessibility: 医疗风险提示使用文字说明，不仅依赖颜色。

### 8.15 Coach Chat / Escalation / To Weekly Plan

- User Flow: 用户明确短期调整后，先确认将调整 Weekly Plan，再进入三栏。
- IA: 左栏保留当前 Weekly Plan 摘要，右栏解释影响范围。
- Visual Hierarchy: `进入本周调整` 为主，`先继续问 Coach` 和 `改成调整赛季训练计划` 为次。
- Interaction: 用户理解后才切换工作区。
- Consistency: 升级前明确计划实体。
- Accessibility: 影响范围和后续需要 Week Diff Review 均为文字说明。

### 8.16 Coach Chat / Escalation / To Master Plan

- User Flow: 用户表达长期降强度后，先确认将调整 Master Plan。
- IA: 左栏保留 Master Plan 摘要，右栏解释会影响赛季目标、阶段、跑量和未来周计划。
- Visual Hierarchy: `进入赛季训练计划调整` 为主，其他选择为次。
- Interaction: 用户可改为只调整本周或继续问 Coach。
- Consistency: 不自动改计划，需后续 Master Plan Diff Review 确认。
- Accessibility: 影响范围和未确认不生效都有文字说明。

## 9. 验证记录

- 已确认 `.stitch/designs/` 存在 16 个新增/微调 Web HTML 文件和对应 16 张 screenshot。
- 已抽查关键文案存在: `查看计划`、`启用计划`、`不改变 Master Plan`、`医疗诊断`。
- Stitch 生成/编辑均使用项目设计系统 `STRIDE Endurance Lab` (`assets/78bc062efcff47b5944c094f5db74850`)。
- 本轮未写前端实现代码，所有新增文件均为设计规范、Review 文档和 Stitch 设计证据。