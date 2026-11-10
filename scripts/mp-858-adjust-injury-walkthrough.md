# #858 PR-E 小程序走查：训练调整弹窗 + 伤病流程（wechatide 手工脚本）

> 供微信开发者工具（wechatide）连本地栈走查用。不要求真机。
> 代码位置：`src/wechat-miniprogram/`（组件 `components/adjust-dialog/`、
> `components/injury-dialog/`；触发 `pages/index`、提示条 `pages/training-plan`；
> 服务 `services/plan-adjustment.ts` / `plan-injury.ts` / `plan-jobs.ts`）。

## 0. 环境准备

1. 本地栈跑起 `stride api`（Go，默认 8082 网关分流）+ `coach_agent_api`（8889），
   小程序 `constants/config.ts` 的 `CURRENT_ENV` 切到 `dev`（默认 prod，注意改回）。
2. 微信开发者工具导入 `src/wechat-miniprogram/`，勾选「不校验合法域名」。
3. 用已绑定微信的测试账号登录小程序（免密登录自动完成）。

## 1. 造数（mock 端点）

### 1a. pending 调整行（内部端点，X-Internal-Token = 部署的 INTERNAL_API_TOKEN）

```bash
UID=<测试账号 uuid>   # GET /api/users/me 的 id
TOKEN=<STRIDE_WORKER_API_INTERNAL_TOKEN 同值>
MPID=<该用户 active master plan 的 plan_id>

# payload 需是合法 JSON 字符串（ escaping 后整体作为 "payload" 字段传入）
PAYLOAD='{"reason":"volume_unmet","window":{"start_week":6,"end_week":8},
 "weekly_docs":[{"schema":"weekly-plan/v1","week_name":"2026-11-09_11-15","sessions":[],"nutrition":[],"notes_md":null,"coach_notes":null}],
 "diff":[{"week":6,"old_km":55,"new_km":42},{"week":7,"old_km":60,"new_km":46},{"week":8,"old_km":58,"new_km":44}],
 "evidence":"上周计划 55km，实际完成 12km（21%）","audit_summary":{"pass":3,"warn":1,"fail":0}}'

curl -s -X POST "http://127.0.0.1:8082/api/internal/users/$UID/plan-adjustments" \
  -H "X-Internal-Token: $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"master_plan_id\":\"$MPID\",\"event_week_start\":\"2026-11-02\",\"reason\":\"volume_unmet\",
       \"question\":\"上周完成得不理想，主要是？\",\"payload\":$(python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$PAYLOAD")}"
```

要点：
- `event_week_start` 必须是周一（YYYY-MM-DD）；同一 event 再次 upsert = 刷新 payload，
  已 accept/dismiss 的 event 返回 409（不再问）。
- 想走「重生成中（payload=null）」态：先正常建行，再 POST choose 一个不同原因
  （curl 同 §2 的 choose），payload 会被清空。

### 1b. 伤病状态（用户端点，直接用小程序自己的 JWT 也行；curl 演示用内部读）

```bash
# 进入伤病（reduced）—— 用户 JWT：
curl -s -X POST "http://127.0.0.1:8082/api/users/$UID/plan-injury/enter" \
  -H "Authorization: Bearer <access_token>" -H 'Content-Type: application/json' \
  -d '{"detail":"左膝外侧疼","verdict":"reduced"}'
# 其余形态：verdict = continue(立即关闭) / rest(完全停) / undecided(pending_doctor)
# 读态：GET /api/users/$UID/plan-injury（404=不在伤病模式）
```

### 1c. 每日一次门（本地 storage）

微信开发者工具 → Storage 面板：
- `last_adjust_popup_day` / `last_injury_ask_day`（上海日 YYYY-MM-DD）。
- 想重弹当天：删掉对应 key（或改成昨天日期）再切 tab 触发 onShow。

## 2. 走查分支清单

### A. 调整弹窗（pages/index 每天首次）

| # | 步骤 | 预期 |
|---|------|------|
| A1 | 造 pending 后冷启/切到「训练」tab | 半屏弹窗 Step1：问句=question、副行=evidence、默认选中「量没练完」 |
| A2 | 关掉再切 tab | 不再弹（storage 门）；训练计划页顶部有提示条 |
| A3 | Step1 改选「没时间跑」→ 查看方案 | choose 返回 202（payload 清空）→ 弹层转 loading「正在按你的情况重新生成…」 |
| A4 | 等待（本地若 coach_api+worker 在跑，约 1-2 分钟） | payload 回填 → Step2：diff 表 W06-W08 旧→新、窗口行、审计一行 |
| A5 | 「同意调整」 | toast「已按新方案调整」→ 关闭；训练计划页周量已变（重拉 plan） |
| A6 | 重新造一行 →「保持原计划」 | 弹窗关闭；再 upsert 同 event 得 409（事件已关） |
| A7 | 选「受伤了」→「去登记伤情」 | 转伤病登记弹层（见 B）；提交后该调整行被 dismiss |
| A8 | choose 异因但停掉 coach_api（8889 不通） | enqueue 失败 → 直接 timeout 态「稍后在训练计划页查看」 |

### B. 伤病登记（enter）

| # | 步骤 | 预期 |
|---|------|------|
| B1 | 从 A7 进入：detail 留空提交 | toast「先简单说一句哪里伤」（不发请求） |
| B2 | detail + 「能继续练」 | 结果文案「好的，计划照旧；伤情有变随时告诉我」；GET plan-injury 变 404 |
| B3 | 「能减量减强度练」 | 「已进入维持训练：E 有氧为主量减半，去质量课；每天会问你恢复情况」 |
| B4 | 「得完全停」 | 「已暂停出课，安心养伤；每天会问你恢复情况」 |
| B5 | 「判断不了，先看医生」 | 「看完医生回来告诉我结论（每天都会问一次）」 |

### C. 每日轻问（pages/index onShow，伤病激活 + 今天没问过）

| # | 步骤 | 预期 |
|---|------|------|
| C1 | reduced/rest 态次日切「训练」tab | 弹层问句「伤怎么样了？」四键 好转/持平/加重/恢复了 |
| C2 | 点「好转」 | 「已记录，量会随恢复情况回抬」 |
| C3 | 点「加重」 | 「收到，先看看现在的情况能怎么练」；次日问句变「伤有变化，现在的情况是？」四选一（enter 覆盖，detail 预填） |
| C4 | 点「恢复了」 | 「已退出伤病模式，训练会按你的最新状态接回」；GET 变 404 |
| C5 | pending_doctor 态（undecided 进入） | 问句「医生怎么说？」三键；点任一 → 对应文案 |

### D. rest + 比赛临近

1. 造 rest 态 + 当前计划的 goal.race_date 距今 ≤ 28 天（改 master plan 或选临近比赛账号）。
2. 打开当日轻问 → 底部多一行「比赛临近，也可以按现状重排整个计划」+「找教练聊聊」。
3. 点「找教练聊聊」→ 关弹层跳教练 tab。

### E. 训练计划页（pages/training-plan）

| # | 步骤 | 预期 |
|---|------|------|
| E1 | 有 pending 调整进页 | 提示条「上周完成情况有调整建议 — 点此确认」（accent 底）；点开同款弹窗（不受每天一次限制） |
| E2 | 伤病激活（无 pending） | 提示条文案 reduced/rest 二态；点击打开当日轻问 |
| E3 | 展开任一阶段 → 周行「每日安排 ▾」 | 懒加载该周 weekly 行 sessions：每日行（周几+日期/课名/km/休息灰显） |
| E4 | 滚动批已出快照外新周（DB 有 weekly 行但快照无） | 新周正常出现在时间轴（挂在最后阶段）、柱图不截断 |

## 3. 已知边界（走查时不用惊讶）

- choose 的 200/202 客户端按「响应 payload 是否为 null」分流，不读状态码（后端两态响应体同形）。
- 轮询 8s×11≈90s 超预算 → timeout 收提示条，pending 行保留，明天不会再追问弹窗
  （popup 门已记今天），提示条常驻直到用户决策。
- 轻问与调整弹窗同天都有时：调整弹窗优先，轻问次日再问（一次只弹一个）。
