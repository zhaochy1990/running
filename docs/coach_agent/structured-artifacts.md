# 教练结构化产物：`$type` 卡片契约与多渲染器架构

状态：已实现（race-strategy 首个接入，2026-10）。关联：#385 展示契约、#396 比赛策略 v2。

教练会话里有一类回复不是「文本」，而是**结构化产物**（比赛策略、未来的
weekly-plan / master-plan）。本文定义它们如何下发到客户端、渲染成卡片、
以及「草稿 → 查看 → 应用」的产品模式。

## 1. 双通道原则

SSE `done`（与同步响应）始终携带两条正交的通道：

```
done = { turn_id, status, message, card? }
```

| 通道 | 形态 | 职责 |
|---|---|---|
| `message` | string（markdown） | 永远存在：历史回看、旧版本客户端、无卡片时的降级渲染 |
| `card` | `{ $type, data }` 信封 | 可选：本轮 intent 命中的结构化产物，客户端渲染通知卡片 |

任一端版本落后都不劣化：新后端 + 旧客户端 → 客户端读 `message`（完整
markdown 渲染）；旧后端 + 新客户端 → 没有 `card`，同样走 markdown 渲染器。

`card` 只出现在最终 `done` 事件，不参与逐 token 流式（`text_delta` 流的
始终是 `message` 文本）。

## 2. `$type` 与双端注册表

`$type` 是双端约定的渲染器 key（kebab-case），等于客户端注册表的入口：

| `$type` | 后端投影（coach_agent_api `publicResponse.ts` 的 `CARD_BY_INTENT`） | 前端注册表（小程序 `utils/coachCards.ts`） |
|---|---|---|
| `race-strategy` | `race_strategy` intent → `raceStrategy` channel | 图标/文案/路由 → 报告页 |
| `weekly-plan`（未来） | `weekly_plan` intent → channel | → 周计划页草稿态 |
| `master-plan`（未来） | `master_plan` intent → channel | → 计划审阅页 |

投影门槛是**双保险**（纵深防御）：orchestrator 每轮把 channel 清零是主闸
（防上一轮产物跨轮残留），投影时再校验「本轮 intent 命中 + channel 有值」
兜住异常路径（如中断轮恢复）——两层缺一不可但动机不同。

## 3. 草稿 → 查看 → 应用（落库语义）

生成**不落库**；落库由用户显式「应用」触发：

1. 教练生成 → `done.card = { $type: "race-strategy", data }` → 聊天气泡出
   通知卡片（标题/副标题/角标「初稿」/CTA「查看并应用」）。
2. 卡片 tap → 产物经 storage 交接（`setPendingStrategyDraft`，navigateTo
   query 带不动大 JSON，沿用 `setPendingCoachContext` 模式）→ 目标页进
   **草稿模式**：本地渲染（编辑可用），底部「应用并保存」。
3. 应用 = 用户 PUT 端点落库（race-strategy 走 `PUT /api/users/me/race-strategies/:race_id`），
   转已保存态。不应用离开 = 放弃初稿（可重新生成）。

动机：重复生成不再静默覆盖用户在报告页的手动编辑；对齐 master-plan 既有的
draft → 审阅 → activate 产品模式。Go 内部写入端点（`POST /api/users/:user_id/race-strategies`，
X-Internal-Token）保留但当前无调用方。

race-strategy 的落库语义（v3 起多版本）：同一 (user, race) 按
`content.target_finish_time` 分版（2:55 一版、2:50 一版），应用/编辑只覆盖
该目标的版本，报告页 pills 切换、`DELETE ?target=` 删版；目标成绩只来自
用户本人的表达——race_strategy 子代理不查能力数据、不代选目标、内容不含
能力分析（详见 RACE_STRATEGY_PROMPT）。

## 4. 防御性信封解析（根因修复）

弱模型偶发不走 ToolStrategy 伪工具调用、把 `{ disposition: "return_direct",
content: {...} }` 信封 JSON 当正文文本输出（2026-09 在 deepseekv4flash 上
观察到原始 JSON 直接打进聊天气泡）。三层防御：

- **后端节点**（`coach_agent/src/agents/race_strategy/render.ts`
  `parseRaceStrategyFromText`）：透传分支对「形似 JSON」的正文（裸 `{`
  开头或 ```json 围栏）做 safeParse（信封/裸对象双口径），命中则捞回成
  正常路径——渲染 markdown 替换正文 + 填 channel，并 log warn（监控
  信号：模型没守格式）。
- **前端流式占位**（`pages/coach/coach.ts`）：旧后端流出 JSON 正文时，
  呈现层换成「正在整理比赛策略…」（原始累积与呈现分离）。
- **历史自愈**（`utils/coachCards.ts` `parseLeakedEnvelope`）：防御上线前
  已写进会话历史的泄漏文本，重开会话时捞回成卡片（需会话带 race target
  才能定位报告页）。

## 5. 扩展指南：新增一种产物卡片

以 weekly-plan 为例。

**后端 3 步**（参考 race-strategy 全链路）：

1. 契约：`coach_contract/src/<domain>/schema.ts` 定义 `XxxSchema`（zod，
   含业务自洽性 superRefine）+ `XxxDirectResponseSchema` 信封；客户端在
   小程序 `services/` 手工镜像 interface（仓内惯例）。
2. 业务节点：仿 `agents/race_strategy/node.ts`——内层 agent 用
   `ToolStrategy.fromSchema` 结构化输出，节点把产物渲染 markdown 进
   `message`（历史/降级用）+ 写专属 state channel（orchestrator 每轮清零
   防 cross-turn 残留）。**不要**用 `masterPlanPassthrough` 的
   `JSON.stringify` 直出路线（那正是把原始 JSON 打进气泡的源头）。
3. 投影：`coach_agent_api/src/publicResponse.ts` 的 `CARD_BY_INTENT`
   加一行（intent → channel → `$type`）。落库端点按需（有专属页面编辑
   才需要，见第 3 节语义）。

**前端 2 步**：

1. 注册表：`utils/coachCards.ts` 的 `buildCoachCard` 加 `$type` 分支
   （形状校验 + 文案/路由），`coachCards.check.mts` 补用例；页面 wxml
   的卡片分支天然复用（组件是类型无关的壳）。
2. 目标页草稿态：storage 交接函数（仿 `setPendingStrategyDraft`）+
   页面 draft 分支（本地渲染 + 底部应用按钮）。

## 6. 已知限制

- 服务端会话历史只存文本（`toPublicHistory`）：卡片仅存在于当轮与本地
  消息缓存；重开会话依赖历史自愈（race-strategy）或 markdown 兜底。若
  未来需要历史保真，需把 card 信封存进 checkpoint 消息 metadata。
- 聊天页卡片是通知型轻卡；完整视图永远在专属页面（报告页/计划页）。
- Web 端（`frontend/`）未接入（其 chat 类型仍镜像废弃的 Python 契约）。
