# 丹尼尔斯训练法·执行回路（R 层）——阈值表与执行时序

> 本文覆盖 daniels.md §3.2 拍板的执行回路骨架在 #858 的落地终态：滚动出课内核、
> 夜检扫描、偏差检测阈值表、调整提案同意流、伤病模式。治理规则同总览：只记录
> **已拍板**的决定（票面 devops#858 Q1-Q14）；实现细节引用代码位置，不复制逻辑。
> 阈值表从单源抄录，供终审逐项过——改阈值=改产品口径，须同步本表与追问弹窗文案。

## 1. 两引擎模型：滚动自动 / 调整同意制（票面拍板）

执行侧有两台引擎，信任模型不同：

| 引擎 | 触发 | 是否需要用户同意 | 产物 |
|---|---|---|---|
| **滚动引擎**（自动） | 用户练到已生成课表的末周（或掉队），夜检自动投 `generate_rolling_block` | **不需要**——练到哪儿出哪儿是既定政策的推论，不是新决定 | 下一块（3+1）周课，直接落库 |
| **调整引擎**（同意制） | 最近一个完整周练得偏离计划（超阈值），夜检建 pending 调整行 | **需要**——改的是「接下来练什么」的处方，用户先选原因、再看方案、可拒绝 | 调整后的剩余批次周课（用户接受才落库） |

大白话：滚动是「照着既定剧本翻下一页」，自动；调整是「上周没按剧本走，要不要改后面的戏」，必须问过用户。

- 滚动批窗判定（边界触发/掉队追赶/到赛周收口）：`coach_agent/src/graph/rolling/window.ts`（`evaluateRollingWindow`，与 worker rolling handler、夜检共享单源）。
- 调整提案行生命周期（pending → accepted / dismissed / superseded）：`src/go/internal/storage/plan_adjustment_models.go`。
- 聊天侧不再有周课生成路径（#858 PR-F 拍板）：周课统一由「master 首批物化 + 滚动」产出，聊天只读库讲解并引导建赛季计划（`coach_agent/src/agents/weekly_plan/agent.ts` + `WeeklyPlanPrompt`）。

## 2. 夜检时序与触发时机

**夜检时序（每晚一次，零 LLM 判定）**：daily-sync 工作流在用户数据同步完成后触发内部端点 `POST /api/internal/coach/rolling-scan`（`coach_agent_api/src/routes/rollingScan.ts`），对每个 active v3 master 计划用户做纯读判定（`coach_agent_api/src/coach/rollingScan.ts` 的 `judgeUserScan`）：

1. **伤病前置**：有 active 伤病态 → 跳过下面两步（见 §5）；
2. **滚动判定**：`computeRollingWindow` 非空 → 投 `generate_rolling_block`；
3. **偏差判定**：最近一个完整周（本周一−7）的 weekly 行对比当周活动 → 非 within_tolerance → 投 `generate_adjustment`（create_pending=true，原因=检测预选）。

**滚动触发时机**：用户**进入已生成的末周**那晚（currentWeek === lastGeneratedWeek = 边界触发；currentWeek > lastGeneratedWeek = 掉队追赶，从当前周起重出、已过日期不回补）。到比赛周后滚动收口。

**调整触发时机（兜底不在夜里）**：夜检建好 pending 行后，用户**打开小程序**时首页兜底查询（`src/wechat-miniprogram/pages/index/index.ts` onShow 拉 pending 调整 + 伤病态），有 pending 且当天没弹过 → 弹追问弹窗（每天最多一次）。

幂等：夜检投递的幂等键含扫描日（上海日），失败次晚可重投；单用户失败跳过不中断。用户答过的事件永不重问（同事件终态行让 upsert 返回 409 事件已关闭）。

## 3. 偏差检测阈值表（#800 终审项）

**单源**：`coach_agent/src/graph/rolling/detect/thresholds.ts`——代码里禁止出现裸数字阈值；本表为抄录，二者不一致以代码为准（改任何一条=改产品口径，须同步本表与追问弹窗文案）。边界语义有单测钉住（`detect/detector.test.ts` / `detect/matcher.test.ts` 的边界用例）。

| 常量 | 值 | 触发方向 | 中文语义 |
|---|---|---|---|
| `PACE_SLOW_PCT` | 5 | **≥ 触发**（4.9% 不算、5.0% 算） | 质量课实际配速比计划慢 5% 及以上算「练差」。只看质量课；E 课/长跑不算练差依据 |
| `MISSED_RATIO` | 0.8 | **< 触发**（79.9% 算没练完、80.0% 不算） | 周完成率（实际/计划）低于 80% 算「量没练完」 |
| `SEVERE_RATIO` | 0.6 | **< 触发**，或质量课全缺 | 周完成率低于 60%（或质量课一节没跑）标记「严重」——文案与升级口径用，不改变触发本身 |
| `OVER_RATIO` | 1.25 | **≥ 触发**（124% 不算、125% 算） | 周完成率不低于 125% 算「完成超量」 |
| `MATCH_DATE_WINDOW_DAYS` | 1 | 匹配窗 | 计划课↔实际活动的日期匹配窗：同日最优，±1 日仍可配（漂移容忍） |
| `MATCH_DISTANCE_TOLERANCE` | 0.35 | ≤ 才可配 | 距离接近度容差：\|实际−计划\|/计划 ≤ 35% 才可配对（差一半明确不配） |

匹配评分权重（同日 > 距离 > 课型）与边界分也在同一单源文件；浮点相等判定带 `RATIO_EPSILON=1e-9` 容差。匹配器实现：`detect/matcher.ts`（综合分降序贪心一对一）。

**分类优先级（先证据后规则）**：跑了别的（有强度属性的对不上的活动且计划课有缺）> 超量 > 缺课侧（质量课/长跑全缺=missed、部分缺=volume_short）> 练差侧（课齐但配速慢=poor_pace；课齐量差=volume_short）> 容忍内。判定器：`detect/detector.ts`。

**混合周缺课 > 练差**：一周里既有缺课又有配速偏慢时，**先看缺课再看配速**——分类优先级里缺课侧排在练差侧前面（缺课是更大的偏差信号，追问预选也优先指向缺课原因）。

## 4. 追问菜单与配方表（调整同意流）

**追问菜单六选一（票面定稿，弹窗选项与 `AskReason` 一一对应）**：配速没达到（pace_unmet）/ 量没练完（volume_unmet）/ 没时间跑（no_time）/ 受伤了（injured）/ 跑了别的（ran_other）/ 完成超量（over_delivered）。检测只做**预选**（preselect，数据猜最可能的原因），用户可改选；受伤永远不预判（由用户自己说）。

**配方表（原因 → 投影参数映射，五条 supported）**：单源 `coach_agent/src/graph/rolling/adjust/recipes.ts`（票面语义逐字落）：

| 原因 | 投影动作 | 注入 L4a 的周指导语（语义） |
|---|---|---|
| pace_unmet 配速没达到 | VDOT −1（配速放缓一档） | 强度课降档：I 改 T 或缩组；量不变 |
| volume_unmet 量没练完 | 骨架回退到实际承受位 | 质量课保 2 节但内容减一档；长跑回退 |
| no_time 没时间跑 | 质量课配额上限=1 | 保 1 节质量课+长跑；E 量先砍；坚决不追补 |
| ran_other 跑了别的 | 不补课不叠加 | 自练/比赛/团练当作已完成吸收；后续绕开 |
| over_delivered 完成超量 | 窗口首周周量 ×0.75 | 下周降载消化；质量课量减半恢复 |
| injured 受伤了 | **不在表内** | 不走调整引擎——伤病模式接管（§5），调用抛错转 permanent error |

流程（大白话）：夜检发现上周练偏了 → 建一行 pending（问句「上周完成得不理想，主要是？」+ 检测证据）→ 用户打开小程序看到弹窗 → 六选一（可改预选）→ worker 按最终原因跑调整投影（重生成当前批次剩余周）→ 弹窗出方案 → 用户**接受**才落库生效。实现：`coach_agent_worker/src/kernel/adjust/handler.ts`。

**拒绝 = 事件关闭，滚动兜底吸收（票面拍板）**：用户点「不需要调整」→ 该调整行 dismissed（终态）；同一事件周**永不重问**（夜检再投 upsert 收 409 事件已关闭，job no-op 成功）。被拒绝后计划不改，但滚动引擎本身吃实际完成数据——L3 滚动种子每周吃实际周，实际少练则后续批次包络自动收紧（daniels.md §3.2「回补策略」既有拍板）。也就是说：拒绝调整不会让系统「装作没看见」，只是把吸收动作从「显式改计划」降级为「滚动投影自然收缩」。

## 5. 伤病模式（票面 Q11/Q14 定稿）

用户在追问菜单选「受伤了」后进入伤病同意流（后端：`src/go/internal/api/plan_injury.go` + `src/go/internal/storage/plan_injury_models.go`；每用户至多一行 active 态）：

- **自判四选一**：continue（照旧不调，仅记录，不落 active 行）/ reduced（减量维持课）/ rest（完全停跑，不出课）/ undecided（判断不了 → 看医生，pending_doctor 待定）。
- **每日轻问（不静默）**：伤病态存在期间每天问一次「伤怎么样」，四答：better / same / worse / recovered。recovered → 删 active 行恢复正常滚动；worse → 置 needs_verdict 要求**重新四选一**（mode 不变、维持课照常驱动）；当天答过当天幂等。
- **待定模式每天问医生**：pending_doctor 期间每天问医生结论，三选一收口：continue（关闭）/ reduced（维持课）/ rest（完全停）。
- **维持课 = 伤前骨架的 50-70%**：reduced 模式每周由 maintenance job（零 LLM 确定性构造）出一张「维持周」——E 有氧为主、去质量课、力量保留、不给配速带（伤病期不推强度）。维持周量锚 `maintenance_km` 每日重估：`clamp(min(当前值×1.05, 近 2 完整周实际均值×1.1), 伤前骨架周量×0.5, 伤前骨架周量×0.7)`——起点伤前骨架的 50-70% 带，回抬每日最多 +5%。构造：`coach_agent/src/graph/rolling/maintenance.ts`；重估与 job：`coach_agent_worker/src/kernel/maintenance/handler.ts`；`maintenance_km` 单一真源取舍（Q14）：Go 只存值，重估全在 TS。
- **与夜检的关系**：有 active 伤病态 → 夜检跳过滚动与偏差判定（维持课由 maintenance job 单独驱动，幂等键含扫描日）；rest 模式且比赛临近（≤4 周）→ 输出 replan_suggest 标记，mp 组合「要不要按现状重排」提示。
- **登记入口**：mp 伤病登记弹窗（`src/wechat-miniprogram/components/injury-dialog/`）+ 每日轻问；恢复跟踪文案与流程见 `src/wechat-miniprogram/utils/injuryFlow.ts`。

## 6. 与生成侧的关系

- 执行回路消费的政策包（L2 意图 + L3 周骨架 + 块标记）来自生成侧一次性产出（daniels.md §3.2「一管线两产物」）；滚动投影不改政策，只把政策按实际进度推演成后续周课。
- master 首批物化（计划生效时先出第一批周课）与滚动投影共用同一周课文档构造单源（`coach_agent/src/graph/rolling/weeklyDocs.ts` 的 `buildWeeklyDocs`，master kernel `nodes.ts` 直接复用）；滚动批生成主入口 `runRollingProjection` 在 `rolling/projection.ts`。
- 换计划（apply/update 新 master）时只清理当前及未来周的旧链/未归链行，已结束的历史周与历史物化课表保留；遗留 pending 提案 supersede（`src/go/internal/storage/weekly_plan.go` 的 `DeleteStaleFutureWeeklyPlans`）——夜检只扫 active v3 行，不会跨计划串课。

## 7. 已知边界

- 偏差检测的完成追踪是启发式匹配（日期窗 ±1 + 距离容差 35% + 课型），`completed_label_id` 全 NULL 的既有缺口由本回路闭环（daniels.md §3.2「完成追踪前置」已满足）。
- goal_assessment 抖动与预灌库 baseline 等遗留事项见 #858 PR 描述「已知事项」节，不在本表展开。
