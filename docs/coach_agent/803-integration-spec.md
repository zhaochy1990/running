# #803 接入 spec：政策包存储与 kernel 新链路接入

> 状态：spec 草稿（wayfinder:grilling 产出，2026-11-02）。阻塞 #796 已关（L4 契约 #807/#811/#799 均收口）。
> 范围：master plan 生成链路替换为新 L1→L4 分层管线 + 政策包落库 + weekly 投影接线 + 灰度。
> 非目标：训练学规则本身的迭代（已在 master 就绪，本票只做接线）；小程序 UI 改版（training-plan 页已消费 master-plan/current，schema 兼容层内消化）。

## 1. 现状盘点（实证 2026-11-02）

| 事实 | 证据 |
|---|---|
| kernel = 13 节点老拓扑，`expand_skeleton` 一次大调用产全期课表 | `graph/master_plan/graph.ts`（strategies 扇出→judges→select→**expand_skeleton**→simulate→rules→validate→reviews→finalize） |
| 生产 kernel 生成基本失败/停用 | master_plan 表最后一条 2026-08-23；9-11 月零行；10-23 spike：真实数据 0/2 过门、每败 9.5min/17 调用 |
| 新链路（L1 evidence→L2 phasing→L3 load→L4 content/schedule）已在 master，回放全绿 | phasing/ 目录；本次上马 5 周实测两版 ✅（含 C15-C17、provenSessions、danielsAudit ✅14⚠️1❌0） |
| 落库 v2 content = 全期课表明细（goal/weeks/phases/milestones…，17-24KB） | master_plan.content JSON_KEYS |
| weekly_plan 表已就绪（master_plan_id/week_start/status_slot/revision），weekly graph 未接 L3/L4（老五阶段 LLM 相位） | DESCRIBE weekly_plan；graph/weekly_plan/graph.ts（phase_base…phase_taper） |
| 两条真实生成链路：聊天 deepagent 卡片 apply_token ＋ worker kernel Admin 代生成 | master-plan-live-paths 调查结论（Python 管线已淘汰勿碰） |
| 小程序 training-plan 页读 GET master-plan/current，消费 v2 周课表 | pages/training-plan |

## 2. 政策包 schema（content v3）

**master_plan.content 升 v3 = 政策包 + 首期课表快照**（v2 兼容层：读路径把 v3 投影回 v2 形状，小程序零改动）：

```jsonc
{
  "schema": "master-plan/v3",
  "policy": {                       // ← L2 PhaseDivisionIntent 序列化（zod 单源，schema 生成物门同 #807 模式）
    "phases": [...], "taper_weeks": 2, "volume_bands": [...],
    "milestones": [...], "gates": [...]
  },
  "skeleton": {                     // ← L3 LoadPlan（周骨架默认轨迹）
    "weeks": [{ "week": 1, "canonical": "final_quality", "role": "progress", "km": 75.2, "lr": 27.1, "q": 2 }],
    "blocks": [...], "recovery_policy": [...], "strength_policy": [...]
  },
  "anchor": {                       // ← 生成时点锚（重生成/滚动种子用）
    "as_of": "2026-11-01", "vdot": 52.9, "vdot_source": "calibration@2026-10-20",
    "seed": { "ctl": 57, "atl": 57 }, "coefficient_version": "lsq-20261029",
    "projection": { "capped": true, "residual": 1.0 }
  },
  "audit": { "items": [...], "summary": { "pass": 14, "warn": 1, "fail": 0 } },   // ← danielsAudit 全量
  "weeks": [...], "phases": [...], "milestones": [...], ...       // ← v2 字段全保留（首期课表快照+兼容投影）
}
```

写路径：`content_version=3`；读路径（GET current/apply_token 消费方）按 `schema` 字段分发，无该字段走 v2 原样。**v2→v3 不迁移**：存量 5 行 superseded/active 均为 8 月前老形态，保留只读。

## 3. kernel 替换设计（新拓扑）

```
initialize → assess_goal（#792 契约）
  → L1_evidence（纯函数：DataProviderMasterPlanContextProvider 快照 + buildPhaseEvidence）
  → L2_phasing（generatePhaseDivisionIntent：flash×1 + 门检 + T 表兜底）
  → L3_load（buildLoadPlan：零 LLM）
  → L4_content（generateWeekContent：L4a flash 课包 + L4b 确定性排位，重试环内建）
  → audit（danielsAudit：纯函数）
  → finalize（v3 组装+落库）
```

- **砍掉**：strategies 三扇出 + judges 九评审（spike 实证收益存疑、成本占 9/17 调用）。策略差异点（峰值周量/LR 峰值/激进度）降级为 L3 可选参数单次调用，默认走公式。
- **回炉环**：L2 门挂→T 表兜底（已内建）；L4 排位无解→带原因重生成 L4a（已内建 ≤2+外层）；终局失败→模板兜底+escalated 原因（已内建）。
- **节点产物沿用** kernel state（GraphState 扩 policy/skeleton/anchor/audit 字段），simulate_load/rules/validate 老节点由 L3 六门+C/P 门+danielsAudit 取代后删除。
- 估时（chaoyi 实测基线）：L2 25-35s + L4 250-1000s ≈ 全链 5-17min/单；Admin job 超时与重试策略按此重定。

## 4. 两条链路嫁接

**A. 聊天 deepagent 卡片 apply_token**：卡片信封 data 从「完整 v2 plan」改为 **v3 政策包摘要**（goal/policy 阶段线/skeleton 周量弧/audit 摘要+apply_token）；点「应用」→ 落库 v3（首期课表快照由服务端生成，卡片不携带全期明细——信封瘦身 #515 同理）。
**B. worker kernel Admin 代生成**：Admin job 直接调新拓扑（同一 createMasterPlanGraph 入口，请求/响应契约不变；MasterPlanGraphRequest 增加 `travel_day` 透传）。

两链路共用 3 的图与 2 的落库——单一事实源。

## 5. weekly 投影接线

- weekly_plan graph 的老五阶段 LLM 相位节点退役，改为：`loadPolicy(读 master_plan v3 policy+skeleton) → R0 scheduleOnly/projection(按块到界生成 weekly content) → simulate(PMC 每夜滚动) → finalize`。
- 生成粒度=块（3+1）：final_quality 含 taper 整段一次生成、recovery 单独成批（daniels.md §3.2 拍板）；L3 滚动种子每周吃实际完成周（已实现）。
- weekly_plan 表写入沿用现有 schema（content=weekly v1 课表）。

## 6. 新增接入点（本周迭代产物）

1. **provenSessions**：kernel L1 节点内从 DataProvider activities 构造（驱动脚本的临时实现上移为 `buildProvenSessions(activities, asOf)` 导出函数+单测）；feel 字段接 activities.feel。
2. **travelDay**：MasterPlanGraphRequest.travel_constraints → ContentRaceContext.travelDay（缺省 saturday）；聊天 intake 追问「周五还是周六到比赛城市」。
3. **danielsAudit**：v3 content.audit 全量落库；小程序 training-plan 页尾部加「丹尼尔斯符合性」折叠区（读 audit.summary+items）。
4. **发版依赖清单**（首批必须）：I3 分级 8ab6cf0a、置休摊量 9e1e2796、taper 原书校准、赛周日常量口径、通勤感知+note 修复、C15v2/C16/C17、provenSessions+danielsAudit（本地 master 领先生产 ~12 commit，一次发版携带）。

## 7. 灰度方案

- 开关：`MASTER_PLAN_V3_GENERATION`（env，coach-api+coach-worker 同读；off=老 kernel 原样）。
- 切换序：① 开发环境全量新链路（回放+真人验收=本次上马两版）→ ② 生产灰度=Admin 代生成先切（可控、失败可见）→ ③ 聊天 apply_token 切（信封 v3）→ ④ 老 kernel 代码删除（下个周期）。
- 读路径永远兼容 v2/v3；回滚=关 flag（老链路保留至 ④）。

## 8. 实施切片

| PR | 内容 | 验收 |
|---|---|---|
| PR-1 | 政策包 v3 schema+zod 单源+schema 生成物门；读写兼容层 | 契约测试：v2 读路径不回归、v3 往返 |
| PR-2 | kernel 新拓扑（§3）+ strategies/judges 删除 + flag | 回放：chaoyi/pan fixture 全绿；真实模型 5 周两目标生成+audit |
| PR-3 | provenSessions/travelDay/audit 三接入点 | 单测+真实链路 payload 断言 |
| PR-4 | weekly 投影接线（§5）+ 每夜滚动 | weekly_plan 表写入+R0 重排幂等 |
| PR-5 | 聊天信封 v3 摘要+apply_token 落库 | E2E：聊天生成→应用→小程序可见 |
| PR-6 | 发版+灰度切流（§7） | 生产首单成功+监控（生成时长/门挂率） |

依赖序：PR-1→PR-2→PR-3→(PR-4 ∥ PR-5)→PR-6。

## 9. 风险与回滚

- flash 时段波动（C3 违规连续败→外层重生成已配，生产 Admin job 须容忍 3-4 次尝试/时长 ~15min）——#798 性能票保持跟踪。
- v3 课表快照与 weekly 投影的一致性：快照仅首期，块界重生成后以 weekly 为准（master_plan.weeks 字段标注 `snapshot_as_of`）。
- 回滚=flag off；落库 v3 行对老读路径不可见（schema 字段分发），无脏读。
