# 自定义比赛收口验证报告（2026-10-10，#476）

对照收口票四项任务逐条执行；截图归档于 workspace 级
`prototypes/476-custom-race/`（非 git 跟踪，与 #456 原型同目录惯例）。
验证对象：master `113942f8`（后端 #547 + 小程序 #551）+ 本分支徽章修复。

## 环境口径

- 本地栈全绿；`stride-api` 用 **2026.10.8**（pin PR stride-devops#453 自动分支上的
  新 tag；master versions.env 的 2026.10.3 不含本端点，会 404）。本地 override：
  `STRIDE_API_IMAGE_TAG=2026.10.8` + `docker compose up -d stride-api`，未合并 pin PR
  （合并=生产发布审批）。
- 赛事中心种子数据 `scripts/seed-race-center.py` 重灌（6 场已发布）。
- curl 鉴权：`keys/private.pem` 自铸 RS256 JWT（iss=auth-service、aud=小程序
  client_id、sub=UUID），两个 sub 做 404 隔离。

## 一、curl 4 端点正反例（19/19 通过）

正例（用户 A）：

| # | 用例 | 期望 | 实际 |
|---|---|---|---|
| 1 | POST 全字段（Trail+D+, registered） | 201 全字段回显 | ✅ |
| 2 | POST 最小字段（无 state、无距离） | 201，state 默认 want | ✅ |
| 3 | POST 过去日期 2025-11-02（补录） | 201，派生 done=true | ✅ |
| 4 | POST 远未来 2030-12-31（修正决议：无 365 天上限） | 201 | ✅ |
| 5 | PUT 全量更新（改 state、缺省可选清空） | 200 | ✅ |
| 6 | PUT race-plans/63（官方报名） | 201 | ✅ |
| 7 | GET my-races 聚合 | 未结束按日期升序混排（official 10-25 插在 custom 之间），done 沉底 | ✅ |
| 8 | DELETE 自己的 id | 204，聚合中消失 | ✅ |

反例：

| # | 用例 | 期望 | 实际 |
|---|---|---|---|
| 9 | item_type="15Km"（白名单外） | 422 | ✅ |
| 10 | item_type="trail"（小写） | 422 | ✅ |
| 11 | race_date="2026/11/15"（斜杠格式） | 422 | ✅ |
| 12 | race_date="2026-13-40"（非法日历日） | 422 | ✅ |
| 13 | 缺 name / 缺 race_date | 422 field required | ✅✅ |
| 14 | state="finished"（词表外） | 422 | ✅ |
| 15 | distance_km=0 / =100000（超 decimal(6,1) 界） | 422 | ✅✅ |
| 16 | 用户 B PUT / DELETE 用户 A 的记录 | 404（隔离，与不存在同文） | ✅✅ |
| 17 | 用户 B GET my-races | items=[]（不见 A 的任何卡） | ✅ |
| 18 | DELETE 不存在 id / 非数字 id / 无 token | 404 / 400 / 401 | ✅✅✅ |

## 二、模拟器三态截图（prototypes/476-custom-race/）

| 文件 | 状态 |
|---|---|
| `state1-mixed-sorted.png` | 有自定义比赛：混排（官方千野湖 10-25 + 自定义 10K 11-01 + 越野 11-15 + 蓉城 11-29）+ 已结束卡灰化沉底；徽章/倒计时/状态 chips/行程勾选/备注/页脚说明齐全（含徽章修复后的「10K」单徽章） |
| `state2a-empty-guide.png` | 完全空态：🗓 还没有参赛计划 + 「去赛事中心逛逛」+ ghost「赛事中心没有？手动添加一场」（实测可点，进全屏表单） |
| `state2b-official-only.png` | 无自定义比赛（有官方计划）：列表只显官方卡，不打扰 |
| `state3-form-validation-error.png` | 表单空提交：toast「请填写比赛名称」；必填星标与日期「无上限：过期自动归入已结束」口径文案同屏 |

## 三、race-plan 回归（全部不回归）

- **官方卡名称跳详情**：点「千野湖越野挑战赛」→ `pages/race-center/detail` ✅（`regress-official-name-detail.png`）
- **状态条切换**：已报名 → 确认参赛，UI chip 点亮 + 服务端 `state=confirmed` 落库 ✅
- **行程勾选**：火车票·机票 未订 → 已订，服务端 `transit=true` ✅（`regress-offboarded-placeholder.png` 同屏可见双已订）
- **offboarded 占位卡**：报名蓉城马拉松后下架 → 灰卡 + 「已下架」徽章 + 「该赛事已被管理员下架，你的参赛记录保留」，无状态条/行程等交互，按日期插在 11-29 位；复刻发布后恢复常规卡 ✅
- **自定义卡镜像交互**：想跑→已报名切换落库 ✅；「···」→编辑回显全字段（editingId/typeChips 高亮 10Km/日期/城市/状态）✅（`regress-edit-prefill.png`）

## 四、对照 #456 决议逐条验收

| 决议条目 | 结果 |
|---|---|
| 变体 A 混排（同一列表按日期混排） | ✅ 后端聚合排序，前端保序 |
| 粉色「自定义」徽章 + 类型（距离）徽章 | ✅（徽章重复已修，见下） |
| 「＋」入口在顶栏右侧；全屏表单页 | ✅（与胶囊按钮视觉贴近为既有布局，功能可点，见观察项） |
| 必填仅名称/日期，类型默认越野跑；距离/爬升/地点/官网/备注可选 | ✅ 表单与 API 双侧一致 |
| 参赛状态 想跑/已报名 chips 点切换（镜像官方卡） | ✅ |
| 已结束=灰化+沉底（去倒计时/状态条，记录保留） | ✅ 派生 done，不落库 |
| 名称不可点（无详情导航、无箭头/高亮） | ✅ wxml 仅官方卡名称绑 onRaceNameTap |
| 酒店/交通行程勾选 | ✅（v1 契约自定义卡不带行程字段，读写均无——符合 #457「v1 不暴露」） |
| 日期无 365 天上限（修正决议） | ✅ API 校验只剩格式；表单提示语同步 |
| 自定义一律私有、不进公共赛历 | ✅ 独立表；race-calendar 返回 6 场种子官方赛，无 custom 混入 |

## 缺口修复（本分支）

- **badgeLabel 重复**：10Km/5Km 类型名自带距离，distance 一致时徽章渲染成
  「10K 10K」。修复：`dist !== typeLabel` 才并列（10Km+15 → 「10K 15K」保留），
  check 用例 3 条新增。`myRaceRows.check.mts` 全过、`tsc --noEmit` 通过。

## 观察项（不改动，待设计裁决）

- **顶栏「＋」与胶囊按钮视觉贴近**：iOS 模拟器下「＋」紧贴胶囊左缘（截图可见）。
  实测可点、无遮挡误触；属既有 top-bar 布局，是否让位给用户拍板（回写 #456
  决议评论）。

## 复现配方（摘要）

```bash
# 栈：stride-devops/local（versions.env pin 换 2026.10.8 或合并 #453 后直接 ./up.sh）
python3 scripts/seed-race-center.py
# token：openssl 签 RS256（脚本见本报告对应会话/issue 评论），sub 必须是 UUID
# 反例三件套：POST /api/users/me/custom-races 携 15Km / 2026-13-40 / 2026/11/15 → 全 422
```
