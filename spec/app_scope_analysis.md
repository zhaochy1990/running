# STRIDE Mobile App 重写 - 范围分析报告

> 输入：设计稿 `index.html` (7398 行) + 功能规格 `spec/app_feature.md` + 现有 Flutter `mobile/` + 后端 `src/stride_server/routes/` + Web `frontend/`。
> 目标：让人类决策者据此分阶段执行。报告只做研究，**不写任何代码**。

---

## 1. 设计稿结构

### 1.1 风格摘要

| 维度 | 设计稿 | 现有移动 App | 差距 |
|------|--------|--------------|------|
| 主题 | **浅色**（`--bg: oklch(98%)`，`--surface: 100%`） | 已是浅色（`background: 0xFAFAFA`，`surface: 0xFFFFFF`） | 一致 |
| 主色 | **STRIDE 绿** `--accent: oklch(58% 0.16 145)` ≈ `#1FAD5B`（更接近 Vercel 绿，**偏暗**） | `accent: 0xFF00E676`（亮荧光绿） | **色调不同**，需校准 |
| 字体 | Sans: `-apple-system / PingFang SC / Inter`；Mono: `JetBrains Mono / IBM Plex Mono / ui-monospace` | 已配（Vercel DESIGN.md） | 一致 |
| 数字 | `font-variant-numeric: tabular-nums`（数据感强烈） | 一致 | 一致 |
| 状态色 | `--warn: oklch(72% 0.13 70)` 琥珀；`--danger: oklch(58% 0.18 25)` 红 | warning `#F59E0B`，danger `#E11D48` | 接近一致 |
| 排版倾向 | **数据密度高**：表格 / stat-row / pill / 时间轴 / 雷达 / mini chart | 当前页面较平淡 | UI 元素需新增大量"信息块"组件 |
| 圆角 | phone 容器 44px；卡片 12-14px；pill 100px | 待对齐 | 需统一 token |
| Pill 状态色 | green / warn / solid / danger，是核心组件 | 当前未抽象 pill 体系 | 需新建 |

**整体气质**：Vercel 风 + 跑步数据科学。低饱和、强对比、**Mono 字体大面积用于数字**、**pill 标签密集**、`stat-row` 三栏统计为基本卡片。设计稿全部 mock 都在 iPhone (390×844) 容器内，无 iPad / 横屏。

### 1.2 设计 Token（提取自 `:root`）

```
--bg          #f7f9fb  (oklch 98% 0.005 250)
--surface     #ffffff
--fg          #2c3340  (oklch 22% 0.02 240) - 主要文字
--fg-soft     #4a5260  (35%)
--muted       #6b7280  (50%) - 次要文字
--muted-2     #aab1bd  (70%) - 占位/弱化
--border      #dfe3ea  (90%)
--border-2    #ebeef3  (94%)
--accent      ~#1FAD5B (oklch 58% 0.16 145) - 重要：与现有 #00E676 不同
--warn        ~#D89A3D
--danger      ~#D74331
--font-mono   JetBrains Mono / IBM Plex Mono / ui-monospace
```

**字号刻度**（实测）：10/11/12/13/14/15(body)/18/20/22/40-64(masthead)。手机内屏多用 12-14，statValue 用 18，section 大标题 20。

**核心组件类型**：`.phone`、`.screen`、`.top-bar`、`.nav-tab`（5 列底栏）、`.seg`（3 段切换）、`.pill`（带 5 种状态变体）、`.stat-row`（3 栏统计）、`.h-rule`。

### 1.3 屏幕清单（按设计稿出现顺序）

设计稿用前缀代码做分组：A/B/C/D/E/F/G = 与 `app_feature.md` 模块对齐；S = 社交；T = 营销/总览（与 onboarding 早期版本）。

**模块 A · 身份认证**
| ID | 名称 | 一句话 | 核心信息块 / 数据 |
|----|------|--------|---|
| A1 | 启动 / 登录入口 | 静态启动屏（设计稿 A1 与 A2 实际为同主题） | logo + 邮箱/密码表单 |
| A2 | 登录 · 邮箱+密码 | "欢迎回来"，主表单 | email / password / 错误文案 / 跳注册 |
| A3 | 注册 · 邮箱+密码+邀请码 | 创建跑者账号 | 邮箱 / 密码（强度）/ 邀请码 / 协议 |

**模块 B · 新手引导**
| ID | 名称 | 一句话 | 核心信息块 |
|----|------|--------|---|
| B1 | 选择手表品牌 | COROS / Garmin 选择，**必选** | 品牌卡 ×2，无跳过按钮 |
| B2 | 绑定手表账号 · COROS | 输入 COROS 邮箱密码 + 区域 | 区域单选 / 邮箱 / 密码 / 仅读权限说明 |
| B3 | 首次同步 · 90 天 | 进度页 | 活动数 / 健康天数 / 进度条 / 重试 |
| B4 | 基础信息采集 | 性别/出生年/身高/体重/RHR/MaxHR | 表单（部分自动填） |
| B5 | 未绑表 · 全屏拦截 | 旧用户兜底 | "需要先绑定一款手表" + CTA |

**模块 T · 早期 onboarding/营销页（与 spec 部分重合）**
| ID | 名称 | 备注 |
|----|------|------|
| T01 | 注册引导 · 目标设定 | 与 C1 高度重合，但更"营销"风。**决策点：是否合并到 C1？** |
| T02 | AI 训练计划 · 总览 | 与 C6 总纲展示页高度重合 |
| T03 | 训练周列表 · 动态生成 | 与 D2a 重合（早期版本） |
| T04 | 本周训练详情 · 重点课/有氧/休息 | 与 D2 / D3 重合 |
| T05 | 重点课反馈 · 6 项问卷 | **比 spec D7 的 RPE 单选更复杂**：6 题问卷（完成情况/RPE/配速达成/体感关键词/疼痛 0-10/自由备注） |
| T06 | 跑步详情 · 分段+心率 | 与 D8 重合（更短版本） |
| T07 | 个人主页 · 13 周热力图 | **设计稿独有**：跑量热力图日历视图。spec 未覆盖 |
| T08 | 个人最佳 · 阶梯 | 与 E6 重合，但"6 个距离"（spec 是 4 距离） |
| T09 | 数据分析 · 12 周窗口 | 与 E2/E3 重合，12 周训练量柱图 |

**模块 C · 训练总纲**
| ID | 名称 |
|----|------|
| C1 | 训练目标采集 |
| C2 | 跑步背景 · 可选 |
| C3 | 3 年历史数据同步 |
| C4 | 总纲生成中 · 推送召回 |
| C5 | 总纲 review · 上下分屏（顶部总纲 + 下部聊天） |
| C6 | 总纲展示页 · sticky hero + 时间轴 + 4 档目标表 + 当前阶段卡 + Z1-Z5 表 + 全阶段表 + 里程碑 + 训练原则 |
| C7 | 总纲对话调整 · 长方案 A/B（含思路、调整表、影响） |
| C8 | 总纲调整历史 · 竖向时间线 |

**模块 D · 单周 & 主循环**
| ID | 名称 |
|----|------|
| D2a | 训练周列表（D 模块入口） |
| D1 | 单周生成中 · 秒级 |
| D2 | 周计划预览（7 天 + E/M/T/I/R 强度标签） |
| D2b | 推送到手表 · 结果 sheet（成功/失败/重试） |
| D3 | 课时详情（含力量动作清单） |
| D4 | 周计划调整 · 聊天 + diff |
| D5 | 主页 · 本周训练 · 7 天课表 + 状态环 + 最近活动 |
| D6 | 训练前 · 热身清单 + 训前营养 |
| D7 | 训后反馈 · RPE + 标签 + 一句话（从 D8 进入） |
| D8 | 活动详情 · 长屏滚动（轨迹/统计/反馈/AI 点评/HR/配速/分段，**无 tab**） |
| D9 | 周复盘 · 周日触发 |

**模块 E · 身体指标**
| ID | 名称 |
|----|------|
| E1 | 健康概览（4 指标 + 睡眠 + AI 解读） |
| E2 | PMC · 训练负荷（ATL/CTL/TSB 三曲线 + 状态区间） |
| E3 | 趋势详情 · 多维度（疲劳/HRV/RHR/睡眠/负荷 切换 + 7/30/90 天） |
| E4 | 能力雷达 · 6 维 4-Layer custom score |
| E5 | 成绩预测 + 目标差距（主距离大字 / 多距离对比 / VO2max / 历史曲线） |
| E6 | PB 记录 · 4 距离 |

**模块 F · 营养**（**全部 spec 新增，后端 0 支持**）
| ID | 名称 |
|----|------|
| F1 | 营养偏好（饮食类型/过敏/目标/BMR+TDEE/宏量比例） |
| F2 | 每日营养建议（训练日 vs 休息日，训前中后） |
| F3 | 营养记录 · 可选（手动记每餐 + 缺口可视化） |

**模块 G · 个人中心**
| ID | 名称 |
|----|------|
| G1 | 个人中心首页（基本信息 + 三组入口） |

**模块 S · 社交**（**设计稿独有，spec 未覆盖**）
| ID | 名称 |
|----|------|
| S01 | 动态流 · 跑步动态 |
| S02 | 动态详情 · kudos + 评论 |
| S03 | 好友 · 社交网络 |
| S04 | 对外公开主页 · 韩晨 |

---

## 2. 设计稿 ↔ 功能规格映射

| 设计稿屏幕 | spec 模块 | 备注 |
|---|---|---|
| A1 / A2 / A3 | A2 / A3 | 1:1 |
| B1-B5 | B1-B5 | 1:1 |
| C1-C8 | C1-C8 | 1:1，C5/C6/C7 实现复杂度极高（聊天 + 长文档 + 时间轴） |
| D2a | D（入口聚合）| spec 未单列，是 D2 的列表入口 |
| D1-D9 | D1-D9 | 1:1 |
| E1-E6 | E1-E6 | 1:1 |
| F1-F3 | F1-F3 | 1:1 |
| G1 | G1 | 1:1 |
| T01 | C1 | **重复**。决策：是否保留 T01 作为"备赛快捷设定"？ |
| T02 | C6 | T02 是更轻的可视化版，建议合并到 C6 |
| T03 | D2a | 重复，建议舍弃 T03 |
| T04 | D2 + D3 | 重复，建议舍弃 T04 |
| T05 | D7（**升级版**）| 6 题问卷 vs spec 的 RPE+标签+一句话。**决策：要不要把 D7 扩展为 6 题问卷？** |
| T06 | D8 | T06 是早期短版，建议舍弃 |
| T07 | D5 / G1 ? | **13 周热力图 spec 未覆盖**，需决策放哪儿 |
| T08 | E6 | T08 是 6 距离，spec 是 4 距离（5/10/HM/FM）。决策：是否扩到 6 距离？ |
| T09 | E2 + E3 | 12 周柱图，合并到 E2/E3 |
| S01-S04 | — | **spec 完全未覆盖社交**。决策：v1 上不上社交？目前 mobile 已有 teams（团队/动态/排行），可以认为这是 teams 的演进 |

**结论**：T 系列大部分应被合并/舍弃；S 系列与 spec 不一致，需要单独决策。

---

## 3. 现有 Flutter App 现状

### 3.1 features/ 屏幕清单

```
mobile/lib/features/
├── activity/         activity_detail_screen.dart + charts/
├── health/           health_screen.dart + charts/
├── login/            login_screen.dart
├── plan/             plan_overview_screen.dart, week_detail_screen.dart
├── profile/          profile_screen.dart, notification_settings_screen.dart, notification_rationale_screen.dart
├── teams/            teams_screen.dart, team_detail_screen.dart
├── today/            today_screen.dart
└── updater/          update_prompt.dart
```

合计 11 个屏幕。**仅覆盖**：登录、Today、活动详情、健康、Plan（列表 + 周详情）、Profile、Teams、通知设置、更新提示。

### 3.2 Routing (go_router)

| Path | Screen | 是否在 shell |
|---|---|---|
| `/login` | LoginScreen | 否 |
| `/today` | TodayScreen | 是（shell 5 tab） |
| `/health` | HealthScreen | 是 |
| `/teams` | TeamsScreen | 是 |
| `/plan` | PlanOverviewScreen | 是 |
| `/profile` | ProfileScreen | 是 |
| `/activity/:id` | ActivityDetailScreen | 否（全屏） |
| `/teams/:teamId` | TeamDetailScreen | 否 |
| `/teams/:teamId/activity/:userId/:labelId` | ActivityDetailScreen | 否 |
| `/plan/weeks/:folder` | WeekDetailScreen | 否 |
| `/notifications/rationale` | NotificationRationaleScreen | 否 |
| `/notifications/settings` | NotificationSettingsScreen | 否 |

Shell 5 tab：Today / Health / Teams / Plan / Profile。**设计稿 D5 主页**有 5 tab，但内容是不同的（设计稿 D5 是"本周训练"作为主页，没明确 5 tab 命名）。

### 3.3 API 客户端覆盖（`data/api/stride_api.dart`）

| 方法 | Endpoint |
|---|---|
| getMyProfile | `GET /api/users/me/profile` |
| getMyTeams | `GET /api/users/me/teams` |
| listActivities | `GET /api/{user}/activities` |
| getActivity | `GET /api/{user}/activities/{labelId}` |
| getTeamActivity | `GET /api/teams/{teamId}/activities/{userId}/{labelId}` |
| getPlanToday | `GET /api/{user}/plan/today` |
| getPlanDays | `GET /api/{user}/plan/days` |
| listWeeks | `GET /api/{user}/weeks` |
| getWeek | `GET /api/{user}/weeks/{folder}` |
| getTrainingPlan | `GET /api/{user}/training-plan` |
| getHealth | `GET /api/{user}/health?days` |
| getPMC | `GET /api/{user}/pmc?days` |
| getAbilityCurrent | `GET /api/{user}/ability/current` |
| getTeam | `GET /api/teams/{teamId}` |
| getTeamFeed | `GET /api/teams/{teamId}/feed?days` |
| getTeamMileage | `GET /api/teams/{teamId}/mileage?period` |
| triggerSync | `POST /api/{user}/sync` |
| pushPlannedSession | `POST /api/{user}/plan/sessions/{date}/{sessionIndex}/push` |
| likeActivity / unlikeActivity | `POST/DELETE /api/teams/{teamId}/activities/{userId}/{labelId}/likes` |
| registerDevice / unregisterDevice | `POST/DELETE /api/users/me/devices` |
| getNotificationPrefs / patchNotificationPrefs | `GET/PATCH /api/users/me/notification-prefs` |

合计 ~22 个调用。

### 3.4 Theme

- 浅色（`background #FAFAFA / surface #FFFFFF`）
- accent `#00E676`（亮荧光绿，**与设计稿 ~#1FAD5B 不同**）
- Vercel gray100-1000 全套
- 已分 zone Z1-Z5 颜色 + 4 种运动类型色

**结论**：theme 基础已搭好，需要将 accent 校准到设计稿色，并补充 pill / stat-row / seg 等组件 token。

---

## 4. 后端 API 现状

按 router 文件分组，标注 mobile/web/两者用：

| Endpoint | 文件 | M/W | 作用 |
|---|---|---|---|
| `GET /api/users` | users.py | W | 列用户（dev） |
| `GET /api/users/me/profile` | profile.py | M+W | 当前用户基础信息 |
| `POST /api/users/me/profile` | profile.py | W | 创建 profile |
| `PATCH /api/users/me/profile` | profile.py | W | 更新 profile |
| `DELETE /api/users/me` | account.py | W? | 账号注销 |
| `POST /api/users/me/coros/login` | onboarding.py | W | COROS 绑表登录 |
| `POST /api/users/me/garmin/login` | onboarding.py | W | Garmin 绑表登录 |
| `POST /api/users/me/onboarding/complete` | onboarding.py | W | 引导完成 |
| `GET /api/users/me/sync-status` | onboarding.py | W | 首次同步状态 |
| `POST /api/users/me/full-sync` | onboarding.py | W | 触发 3 年全量同步（C3 用）|
| `GET /api/users/me/full-sync-status` | onboarding.py | W | 全量同步状态 |
| `GET /api/users/me/watch` | watch.py | W | 已绑手表信息 |
| `DELETE /api/users/me/watch` | watch.py | W | 解绑手表 |
| `POST /api/users/me/devices` | notifications.py | M | 注册推送 token |
| `DELETE /api/users/me/devices/{id}` | notifications.py | M | 注销 token |
| `GET /api/users/me/notification-prefs` | notifications.py | M | 通知偏好 |
| `PATCH /api/users/me/notification-prefs` | notifications.py | M | 改通知偏好 |
| `GET /api/{user}/activities` | activities.py | M+W | 活动列表（分页）|
| `GET /api/{user}/activities/{id}` | activities.py | M+W | 活动详情（laps/zones/timeseries 全量） |
| `POST /api/{user}/activities/{id}/commentary` | activities.py | CLI | 写 commentary |
| `POST /api/{user}/activities/{id}/commentary/regenerate` | activities.py | W | 重新生成 commentary |
| `POST /api/{user}/activities/{id}/resync` | activities.py | M+W | 重新拉取该活动 |
| `POST /api/{user}/sync` | sync.py | M+W | 触发完整同步 |
| `GET /api/{user}/dashboard` | health.py | W | 仪表盘聚合 |
| `GET /api/{user}/health?days` | health.py | M+W | 健康时序 |
| `GET /api/{user}/hrv` | health.py | W | HRV |
| `GET /api/{user}/pmc?days` | health.py | M+W | PMC（CTL/ATL/TSB）|
| `GET /api/{user}/stats` | health.py | W | 统计聚合 |
| `GET /api/{user}/body-composition` | body_composition.py | W | 体测列表 |
| `GET /api/{user}/body-composition/summary` | body_composition.py | W | 体测概览 |
| `GET /api/{user}/body-composition/{scan_date}` | body_composition.py | W | 体测单条 |
| `POST /api/{user}/body-composition` | body_composition.py | W | 上传体测数据 |
| `GET /api/{user}/plan/today` | plan.py | M | 今日课 |
| `GET /api/{user}/plan/days?from&to` | plan.py | M | 区间课 |
| `POST /api/{user}/plan/sessions/{date}/{idx}/push` | plan.py | M+W | 推送到手表 |
| `POST /api/{user}/plan/reparse` | plan.py | internal | 重新解析 plan.md |
| `POST /api/{user}/plan/{folder}/variants` | plan_variants.py | CLI | 上传变体 |
| `GET /api/{user}/plan/{folder}/variants` | plan_variants.py | W | 列变体 |
| `POST /api/{user}/plan/variants/{id}/rate` | plan_variants.py | W | 评分 |
| `POST /api/{user}/plan/{folder}/select` | plan_variants.py | W | 选定 |
| `DELETE /api/{user}/plan/{folder}/variants` | plan_variants.py | W | 清变体 |
| `GET /api/{user}/weeks` | weeks.py | M+W | 周列表 |
| `GET /api/{user}/weeks/{folder}` | weeks.py | M+W | 周详情（plan/feedback/activities） |
| `PUT /api/{user}/weeks/{folder}/feedback` | weeks.py | W | 改 feedback |
| `PUT /api/{user}/weeks/{folder}/plan` | weeks.py | W | 改 plan |
| `GET /api/{user}/weeks/{folder}/strength` | strength.py | W | 力量结构 |
| `GET /api/{user}/training-plan` | training_plan.py | M+W | TRAINING_PLAN.md + phase |
| `GET /api/{user}/ability/current` | ability.py | M+W | 能力快照 |
| `POST /api/{user}/ability/backfill?days` | ability.py | W | 回填能力 |
| `GET /api/{user}/ability/history` | ability.py | W | 能力历史 |
| `GET /api/{user}/activities/{id}/ability` | ability.py | W | 单活动能力 |
| `GET /api/{user}/ability/weights` | ability.py | W | 能力权重 |
| `POST /api/{user}/workout/run` | workouts.py | W? | 推 run workout |
| `GET /api/teams` | teams.py | W | 列团队 |
| `POST /api/teams` | teams.py | W | 建团队 |
| `GET /api/teams/{id}` | teams.py | M+W | 团详情 |
| `DELETE /api/teams/{id}` | teams.py | W | 解散 |
| `POST /api/teams/{id}/join` | teams.py | W | 加入 |
| `POST /api/teams/{id}/leave` | teams.py | W | 退出 |
| `POST /api/teams/{id}/transfer-owner` | teams.py | W | 转移 |
| `GET /api/teams/{id}/members` | teams.py | W | 成员 |
| `GET /api/teams/{id}/activities/{user}/{label}` | teams.py | M+W | 团队视角活动详情 |
| `GET /api/teams/{id}/feed?days` | teams.py | M+W | 团队 feed |
| `POST /api/teams/{id}/sync-all` | teams.py | W | 同步所有成员 |
| `GET /api/teams/{id}/mileage?period` | teams.py | M+W | 排行榜 |
| `GET /api/users/me/teams` | teams.py | M+W | 我的团队 |
| `POST/DELETE/GET /api/teams/{id}/activities/{u}/{l}/likes` | likes.py | M+W | 点赞 |

合计 ~55 endpoints。

---

## 5. API 缺口（必须新增的后端能力）

按"功能 → endpoint 草案 → I/O → 复用情况"列：

| # | 功能（设计稿屏幕）| 需要的 endpoint | 输入 | 输出 | 复用 Web 现有？ |
|---|---|---|---|---|---|
| 1 | **C1 训练目标采集** | `POST /api/users/me/training-goal` | 目标类型 / 比赛日 / 距离 / 目标时间 / 每周天数 / 时段 / 力量意愿 | goal 实体 | 否，新增 |
| 2 | **C1 读取目标** | `GET /api/users/me/training-goal` | — | 当前 goal | 否 |
| 3 | **C2 跑步背景** | `POST /api/users/me/running-profile` | 跑龄 / 周量 / PB / 伤病 | profile 实体 | 否 |
| 4 | **C3 3 年同步**（推动）| **已有** `POST /api/users/me/full-sync` + `GET /api/users/me/full-sync-status` | days=1095 | 进度 | ✅ 可直接复用 |
| 5 | **C4 总纲生成（异步任务）** | `POST /api/users/me/master-plan/generate` | goal_id, profile_id | `{job_id, eta_seconds}` | 否，新增（后台 LLM job） |
| 6 | **C4 任务状态** | `GET /api/users/me/master-plan/jobs/{job_id}` | — | `{state, stage, progress, error}` | 否 |
| 7 | **C5 总纲聊天 review** | `POST /api/users/me/master-plan/{plan_id}/review/messages` | `{message}` | `{ai_response, diff_proposal}` | 否，**LLM 对话流** |
| 8 | **C5 接受 diff / 落库** | `POST /api/users/me/master-plan/{plan_id}/confirm` | accepted diffs | confirmed plan | 否 |
| 9 | **C6 总纲展示** | `GET /api/users/me/master-plan/current` | — | 完整总纲（阶段/周量/里程碑/Z1-Z5/原则） | 部分可复用 `/api/{user}/training-plan` 但**结构不同**，建议新增 |
| 10 | **C7 总纲对话调整（新一轮）** | `POST /api/users/me/master-plan/{plan_id}/adjust/conversations` + `messages` | message | diff + 方案 A/B | 否 |
| 11 | **C8 总纲调整历史** | `GET /api/users/me/master-plan/{plan_id}/versions` + `GET .../versions/{v}` + diff endpoint | — | 版本列表 / 单版本 / 对比 | 否 |
| 12 | **D1 单周生成** | `POST /api/{user}/plan/weeks/generate` | `{week_start, source: 'auto'|'manual'}` | 生成的 week folder + 内容 | 否，新增（与多变量 plan_variants 流程**不同**，这里是单一确定的生成） |
| 13 | **D4 单周聊天调整** | `POST /api/{user}/plan/{folder}/chat/messages` | message | `{ai_response, plan_diff}` | 否 |
| 14 | **D4 接受调整** | `PUT /api/{user}/plan/{folder}` | new plan md / json | 已有但语义需扩展 | 部分复用 |
| 15 | **D2b 推送到手表（结果汇总）** | 已有 `POST /api/{user}/plan/sessions/{date}/{idx}/push`，但**一次性推送整周**需要新接口 `POST /api/{user}/plan/{folder}/push` | — | `{total, success, failed: [{date, idx, reason}]}` | 部分新增，包装现有 |
| 16 | **D7 训后反馈（结构化）** | `PUT /api/{user}/activities/{id}/feedback` | `{rpe, mood_tags[], note}` | OK | 否；目前 `sport_note` 是 COROS 同步回来的，不是 App 写的。**核心新接口** |
| 17 | **D9 周复盘** | `GET /api/{user}/weeks/{folder}/review` | — | `{completion_rate, mileage, tsb_series, sessions[{plan_vs_actual, ai_review}], 3_insights, next_week_preview}` | 否，新增（聚合 + LLM 洞察） |
| 18 | **E4 能力雷达 6 维** | 已有 `/api/{user}/ability/current` | — | 当前 4-Layer score | ✅ 可复用，但需要返回"维度解读 + 提升建议"——可能需要扩展或新增 `/ability/insights` |
| 19 | **E4 能力维度历史 mini chart** | 已有 `/api/{user}/ability/history` | — | 历史 | ✅ 复用 |
| 20 | **E5 成绩预测 + 历史预测曲线** | 部分新增 `GET /api/{user}/race-predictions` + `GET /api/{user}/race-predictions/history?days=` | — | 多距离当前预测 / 历史时间序列 | 部分（dashboard 含 race_prediction 字段，但**需要历史时序**） |
| 21 | **E5 与目标差距** | 派生：goal + 预测，可在 prediction endpoint 直接返回 `target_gap` | — | — | 复用 #20 |
| 22 | **E6 PB 自动检测** | `GET /api/{user}/pbs` | — | `[{distance, pb_time, achieved_at, history[]}]` | 否，新增（目前只在 activity 里散落） |
| 23 | **F1 营养偏好** | `GET/PUT /api/users/me/nutrition-prefs` | dietary/allergies/goal/macros | prefs | 否 |
| 24 | **F2 每日营养建议** | `GET /api/{user}/nutrition/daily?date=` | — | `{calories, macros, pre/intra/post, meals[]}` | 否 |
| 25 | **F3 营养记录** | `POST/GET /api/{user}/nutrition/meals` | meal | OK | 否 |
| 26 | **T07 13 周热力图**（如保留）| `GET /api/{user}/heatmap?weeks=13` | — | `[{date, distance}]` 13×7 | 可从 activities 聚合，建议新增预聚合 endpoint 减少手机端计算 |
| 27 | **D2a 周列表带完成进度 mini 课表** | 扩展 `/api/{user}/weeks` 增加 `{completion_rate, mini_calendar:[{date, type, status}]}` | — | — | 部分复用，需扩展 |
| 28 | **D5 主页聚合**（一次拉全：今日课 + 状态环 + 7 天 + 最近活动）| 新增 `GET /api/{user}/home` | — | 聚合 payload | 否（强烈建议预聚合）|
| 29 | **B4 自动填 RHR/MaxHR** | 派生：从 `/health` 取 RHR；MaxHR 用 220-age；可在 onboarding 内补 `GET /api/users/me/onboarding/defaults` | — | `{suggested_rhr, suggested_max_hr}` | 否，但实现成本低 |

**总结**：约 **25 个全新 endpoint + 6 个扩展现有 endpoint**。其中"LLM 对话 + diff"类（C5/C7/D4 + D9 洞察）是**最大技术风险**，需独立设计 LLM job runner + diff schema。

---

## 6. Web Endpoint 不适合移动端的清单

| Endpoint | 问题 | 移动端方案 |
|---|---|---|
| `GET /api/{user}/activities/{id}` | 一次性返回 laps + zones + **完整 timeseries（每秒/每点）**。一个 1 小时活动 ~3600 点，4G 下慢且费内存。 | **新增 `?fields=` 或拆分**：`/activities/{id}` 默认不带 timeseries；`/activities/{id}/timeseries?downsample=300` 单独取，下采样后只 300 点。 |
| `GET /api/{user}/health?days=30` | days 不限上限；手机端可能传 365 一次拉爆。 | 强制服务端 cap 至 180；客户端默认 30。 |
| `GET /api/{user}/pmc?days=90` | 一次返回每日数据；移动端 180 天图表只需要约 26 周聚合点 | 新增 `?granularity=daily|weekly` 选项；移动端用 weekly。 |
| `GET /api/{user}/dashboard` | 设计为 PC 宽屏，含 race_prediction + 大量字段；手机不一定都用。 | 移动端走 `/api/{user}/home`（新增预聚合），避免这个 endpoint。 |
| `GET /api/{user}/weeks/{folder}` | 同时返回 plan + feedback + activities 列表 + 结构化 sessions。移动端如果只看 plan 不需要 activities。 | 加 `?include=plan,feedback,sessions,activities` 选择性返回；或拆 `/weeks/{folder}/plan`、`/weeks/{folder}/sessions`。 |
| `GET /api/{user}/training-plan` | 返回完整 TRAINING_PLAN.md（可能极长）+ 解析的 phase。手机端**屏幕窄**渲染长 markdown 体验差。 | 新增 `GET /api/users/me/master-plan/current` 返回**结构化字段**（不是裸 markdown），移动端按 C6 卡片展示。Web 仍可消费原 endpoint。 |
| `GET /api/{user}/ability/history` | 默认返回全部历史。手机端只画 mini chart 12-26 点。 | 加 `?points=12&aggregation=weekly`。 |
| `GET /api/teams/{id}/feed?days=30` | 团队动态列表，含每条全字段 + 完整 activity stats。手机端列表只要标题 + 距离 + 配速 + thumbnail。 | 加 `?summary=true` 返回精简卡片；详情走 activity endpoint。 |
| `GET /api/{user}/body-composition` | 体测全列表 + 每次全字段（30+ 字段）。手机端只展示趋势 mini，不展示原始报告。 | 加 `?summary=true` 只返回 `{date, weight, body_fat_pct, skeletal_muscle_mass}`。 |
| `GET /api/{user}/stats` | Web 宽屏多卡片聚合；移动端用不上其中部分（如年度全图）。 | 移动端不调用此 endpoint，所有所需统计走 `/api/{user}/home`。 |
| `POST /api/{user}/sync` | 同步是耗时操作，HTTP 长连接在 4G 下可能超时。 | 改为异步任务模型：`POST` 立即返回 `job_id`，再 `GET .../sync/jobs/{id}` 轮询；或复用 `/full-sync-status` 模式。 |
| 所有 `/api/{user}/...` 路径中的 `{user}` | 移动端反复传 user_id；要求每次匹配 JWT sub。但 mobile 单用户场景下重复信息。 | 提供 `/api/me/...` 别名（语义等同 `/api/{自己的 user_id}/...`），简化 URL。**非必需，仅 DX 改善**。 |

---

## 7. 重写工作量切片建议

### M1 - 基础设施 + 主循环骨架（最高优先级，2-3 周）
**目标**：用户能登录、绑表、看到主页、看到活动、看健康。
- 屏幕：A1/A2/A3、B1/B2/B3/B4/B5、D5（主页）、D8（活动详情）、E1（健康概览）、G1（个人中心）
- 后端：复用现有 onboarding / sync-status / activities / health / dashboard / profile
- **后端新增**：`/api/{user}/home` 聚合 endpoint（#28）、`/activities/{id}/timeseries?downsample=` 拆分
- 工作量：**L**

### M2 - 周计划主循环（3-4 周）
**目标**：自动+手动单周生成 → 看周计划 → 看课时详情 → 推手表 → 训后反馈。
- 屏幕：D1、D2、D2a、D2b、D3、D4、D6、D7、D9
- **后端新增**：D1 单周生成 / D4 聊天调整 / D7 结构化反馈 / D9 周复盘聚合（#12-#17）
- LLM job runner 基础设施（D4 聊天 + diff）
- 工作量：**XL**（LLM diff 是难点）

### M3 - 训练总纲（4-5 周，最大风险）
**目标**：C 模块全链路。
- 屏幕：C1-C8
- **后端新增**：goal / running-profile / master-plan generate/job/review/confirm/versions/diff（#1-#11）
- 复用 full-sync（C3）
- LLM 异步生成（分钟级）+ 推送召回
- 总纲对话调整（C7）和单周调整（D4）共享 LLM 对话基础设施
- 工作量：**XL**

### M4 - 身体指标深度（2 周）
**目标**：E 模块完整。
- 屏幕：E2/E3/E4/E5/E6
- 复用 pmc/health/ability/current/history；扩展 `?granularity` / `?points`
- **后端新增**：race-predictions/history（#20）、pbs（#22）、ability/insights（#18）
- 工作量：**M**

### M5 - 营养（3 周，可选 v1.x）
**目标**：F 模块。
- 屏幕：F1/F2/F3
- **后端全新**：F1/F2/F3 三套 endpoint + LLM 推荐
- 工作量：**L**

### M6 - 社交（可选）
**目标**：S 模块或 teams 升级。
- 屏幕：S01-S04
- 复用现有 teams / likes / feed，扩展 `?summary=`
- **决策点**：要不要做 spec 没写的功能？建议 v1 砍掉，保留现有 teams tab。
- 工作量：**M-L**

### 持续支撑（贯穿所有 M）
- Theme 校准（accent 色统一）
- Pill / stat-row / seg / phone-card 组件库
- Push notification（D7/D9/C4 召回）
- Updater / 错误处理 / 离线降级

---

## 8. 未解问题（执行前必须用户决策）

1. **设计稿 accent 色 vs 现有 `#00E676`**：以谁为准？建议**改用设计稿色**统一调试。
2. **T 系列屏幕是否保留**：T01/T05/T07/T08/T09 与 spec 部分冲突——
   - T01 与 C1 重复，**建议合并到 C1**。
   - T05（6 题问卷）vs spec D7（RPE+标签+一句话），**哪个胜出？** 我倾向 T05，更有信息量。
   - T07 13 周热力图 spec 未覆盖，**放主页 D5 还是个人主页 G1？**
   - T08 6 距离 vs spec E6 4 距离，**统一为？**
3. **S 系列社交（S01-S04）在 v1 是否做？** spec 未写。**建议 v1 砍掉**，保留现有 teams tab；S 系列放 v1.x。
4. **旧 App 屏幕去留**：今 today/teams/profile/health/plan/activity 都需要按设计稿**重写**而非保留；`updater/notifications` 等支撑屏幕保留即可。**确认这是"UI 全部重写"的范围吗？**
5. **5 个底部 tab 命名**：设计稿没明确给出。建议：主页(D5) / 训练(D2a) / 数据(E1) / 社交或团队(S/teams) / 我(G1)。**用户拍板。**
6. **LLM 对话 + diff schema**：C5/C7/D4 都依赖 LLM 返回"plan diff"。这要统一定义。是 JSON Patch 风格还是自定义？**架构决策。**
7. **总纲生成的耗时**：spec 说"分钟级，离开 App 也能跑"。需要后台 job + 推送召回。**确认走 JPush，不依赖 OEM 通道？**（按 MEMORY.md 已决定走 JPush）
8. **数据隔离**：spec C3 要拉 3 年历史；旧 user 已存 90 天。**首次同步策略：B3 拉 90 天，C3 触发时再拉 3 年？还是直接 3 年？** 影响 onboarding 体感。
9. **D7 反馈写入路径**：当前 `sport_note` 是 COROS 同步回来的字段。D7 写的是**本地新建的字段**还是**通过 COROS API 反写到手表上**？这影响数据模型。
10. **E6 PB 是否自动从 activities 推断 vs 用户手动声明？** spec 写"自动检测"，但要不要支持用户在 race 中手动 mark "比赛 PB" 标签？
11. **营养模块（F）v1 是否做？** 工作量 ~3 周且后端 0 基础。**建议推到 v1.x**。
12. **Garmin v1.1 支持**：B1 设计稿写"Garmin（v1.1 即将支持）"，那么 v1 只放 COROS 单选？还是 v1 占位 Garmin 但置灰？

---

## 9. 推荐的下一步执行路径

### 9.1 顺序建议

**先做 M1（主循环骨架）**，理由：
- 设计稿主线故事是"绑表 → 看到价值 → 主动设目标"，M1 完成后用户**有完整可用的 App**（不依赖训练总纲）。
- M1 几乎完全复用现有后端，**无 LLM 阻塞**，是最快交付价值的切片。
- 完成 M1 即可灰度发布给现有用户，**验证 UI 重写质量**，再开始重投入 M2/M3。

**然后做 M2（周计划主循环）**：
- 这是 spec 的"日常主循环"，比 M3 的"长期总纲"使用频率高得多。
- LLM 对话 + diff 基础设施在 M2 先做（D4 单周调整），到 M3（C5/C7）就有了模板。

**M3（总纲）放第三**：
- 高复杂度 + 高风险（LLM 长生成、版本管理、对话调整）；放后期。
- 同时也是产品差异化最强的部分，做完之前 App 可以以"无总纲"路径运行。

**M4（身体指标）穿插或并行**：
- 复用现有 endpoint 多；可让一名前端独立并行做。

**M5（营养） / M6（社交）作为 v1.x**：
- 砍出 v1 范围，缩小风险。

### 9.2 立刻可启动的"零阻塞"工作

不需要任何决策即可开始：
1. **校准 theme**：accent / pill / stat-row token，对齐设计稿。
2. **组件库**：基于设计稿 CSS 抽 `Pill / StatRow / SegControl / TopBar / NavTab` Flutter widget。
3. **后端预聚合 `/api/{user}/home`**：当前的 today + recent_activities + health summary 合并一个端点。

### 9.3 需立刻拍板的事

- 上述 8 个未解问题中的 #1（色调）、#2（T 屏幕去留）、#3（社交 v1 与否）、#5（tab 命名）、#11（营养 v1 与否）：**这 5 条直接影响 M1-M6 排期**，建议本周内决策。
- 其余（LLM diff schema / 推送通道 / Garmin 时机）可在 M2 开工前拍板。

---

*报告完。*
