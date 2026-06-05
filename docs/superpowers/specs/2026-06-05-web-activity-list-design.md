# Web 活动列表 — Design Spec

**Date**: 2026-06-05
**Status**: Approved, ready for implementation planning
**Scope**: 仅实现 React Web SPA 的活动列表页面，并适配手机浏览器。Flutter 移动端不在本次范围内。

---

## 1. 背景与目标

用户希望在 STRIDE Web 端按 `spec/web_design.html` 实现独立的“活动列表”页面。该页面展示全部已同步活动，支持筛选、分页、按月份分组，并从活动行跳转到现有活动详情页。

设计稿将“活动列表”放在左侧主功能导航中，与“本周训练”“训练计划”并列。因此本次实现不采用 `/plan` 内入口卡片方案，而是新增一级 Web 页面。

---

## 2. 路由与导航

新增 Web 路由：

```text
/activities
```

导航变化：

- `frontend/src/components/AppLayout.tsx` 的“主功能”区新增 `活动列表`。
- 图标沿用设计稿的 pulse/activity 线形图标风格。
- 活动列表导航项在 `/activities` active。
- 不改 Flutter `mobile/`。

面包屑：

- `/activities` -> `训练 / 活动列表`
- `/activity/:id` 保持活动详情页，但若从活动列表进入，浏览器返回应自然回到 `/activities`。

遥测 route name：

- `/activities` -> `Activity List`

---

## 3. 页面结构

新增页面组件：

```text
frontend/src/pages/ActivitiesPage.tsx
```

页面按设计稿结构实现：

1. `ViewHead`
   - eyebrow: `活动记录 · 全部`
   - title: `活动列表`
   - lede: `来自 COROS / Garmin 自动同步并匹配课次。点击任意活动查看完整详情、分段与教练点评。`
2. 本月统计
   - 标题：`本月统计 · YYYY 年 M 月`
   - 6 项统计：本月跑量、跑步时长、平均配速、平均心率、力量训练、力量时长
3. 筛选栏
   - 类型：全部 / 跑步 / 力量训练
   - 距离下限：全部、>= 5/10/15/20/25/30/35/40 km
   - 日期范围：开始日期、结束日期、应用、重置
4. 活动列表
   - 按月份分组
   - 每组显示月份和聚合摘要：活动数、跑步距离、总时长
   - 每行展示图标、标题、日期/地点等元信息、5 个指标、箭头
5. 分页
   - 每页 12 条
   - 显示 `显示 X-Y / 共 Z 条`
   - 上一页、页码、下一页
6. 空状态
   - `该范围暂无活动记录。`

---

## 4. 数据来源与筛选

复用现有 API：

```ts
getActivities(user, { dateFrom, dateTo, limit, offset, sport })
```

服务端已支持分页、时间范围、`sport` 过滤。距离下限在前端筛选，因为当前 API 没有距离过滤参数。

### 4.1 列表数据

列表请求策略：

- `limit = 200` 拉取筛选日期范围内的活动。
- 前端应用距离下限过滤。
- 前端分页为每页 12 条。
- 若 API 总数超过 200，需要翻页拉全当前筛选范围，避免前端距离过滤后分页不完整。

实现上可在 `frontend/src/api.ts` 新增通用 helper：

```ts
getAllActivities(user, opts): Promise<Activity[]>
```

或复用已有 `getAllActivitiesInRange` 并扩展为支持 `sport`。不重复造轮子。

### 4.2 本月统计

本月统计按 Asia/Shanghai 当前月份计算：

- 用 `shanghaiToday()` 得到今天。
- 月初 `YYYY-MM-01`，月末用本月最后一天。
- 拉取该月活动后前端聚合。

统计规则：

- 本月跑量：跑步类活动 `distance_km` 求和。
- 跑步时长：跑步类活动 `duration_s` 求和，显示小时分钟。
- 平均配速：跑步类活动总时长 / 总距离。
- 平均心率：按活动时长加权平均 `avg_hr`，忽略空值。
- 力量训练：力量类活动数量。
- 力量时长：力量类活动 `duration_s` 求和，显示分钟。

---

## 5. 活动行展示规则

运动类型归类：

- 跑步：`sport_name` 包含 `Run` 或现有 `sportNameCN` 映射为跑步相关。
- 力量：`sport_name` 为 `Strength Training` / `Strength` 或 `sport_type` 为力量训练相关值。
- 其他运动在“全部”中展示，但不计入跑步/力量统计。

跑步行指标：

- 距离：`distance_km`，2 位小数
- 配速：`pace_fmt`
- HR 均：`avg_hr` 或 `-`
- 步频：`avg_cadence` 或 `-`
- 用时：`duration_fmt`

力量行指标：

- 用时：`duration_fmt`
- 组数：若 API 没有结构化组数则显示 `-`
- HR 均：`avg_hr` 或 `-`
- 最大 HR：`max_hr` 或 `-`
- 能量：`calories_kcal` 或 `-`

标题：`activity.name || sportNameCN(activity.sport_name)`。

日期显示必须使用 `formatDateShort` / `shanghaiDate` 相关 helper，避免浏览器本地时区漂移。

---

## 6. 响应式设计

目标是 Web 页面在手机浏览器可用，不实现 Flutter 移动端。

### 桌面

- 页面最大宽度沿用现有页面：`max-w-5xl mx-auto px-4 py-6 sm:px-8 sm:py-8`。
- 本月统计为 6 列。
- 筛选栏横向排列，可换行。
- 活动行使用桌面网格：图标 + 标题 + 5 个指标 + 箭头。

### 手机浏览器

- 左侧导航沿用现有 `AppLayout` 抽屉。
- 本月统计变为 2 列。
- 筛选控件纵向/折行布局，日期输入能完整显示。
- 活动行变为卡片：标题与日期在上，关键指标在下。
- 小屏隐藏低优先级指标，至少保留：距离/用时/配速/心率。
- 分页控件允许换行，避免横向溢出。

---

## 7. 错误、加载与空状态

加载状态：页面中间显示现有绿色 spinner 风格。

错误状态：显示 `加载失败`、错误信息和 `重试` 按钮。

空状态：筛选结果为空时显示 `该范围暂无活动记录。`。

无用户 ID：保持现有页面模式，不发请求。

API 401 等认证错误由 `fetchJSON` 现有逻辑处理。

---

## 8. 测试计划

新增测试文件：

```text
frontend/src/pages/__tests__/ActivitiesPage.test.tsx
```

测试覆盖：

1. 渲染标题、lede、本月统计和筛选控件。
2. API 返回活动后按月份分组展示。
3. 类型筛选：跑步 / 力量训练切换后列表更新。
4. 距离筛选：`>= 10 km` 排除短距离和无距离力量活动。
5. 日期范围应用：调用 API 时带 `dateFrom` / `dateTo`。
6. 分页：超过 12 条时显示分页，点击下一页更新列表。
7. 空状态：筛选后无结果显示空状态。
8. 点击活动行导航到 `/activity/:id`。

现有测试更新：

- `frontend/src/telemetry/__tests__/routeNames.test.ts` 增加 `/activities`。
- 若 `Breadcrumb` 有测试，增加 `/activities`；否则覆盖在新页面测试或轻量新增。

---

## 9. 实施文件清单

预计修改：

- `frontend/src/App.tsx`：注册 `/activities`。
- `frontend/src/components/AppLayout.tsx`：新增侧边导航项。
- `frontend/src/lib/breadcrumb.ts`：新增 `/activities` 面包屑。
- `frontend/src/telemetry/routeNames.ts`：新增 route name。
- `frontend/src/pages/ActivitiesPage.tsx`：新增页面。
- `frontend/src/api.ts`：复用或扩展活动翻页 helper。
- `frontend/src/pages/__tests__/ActivitiesPage.test.tsx`：新增页面测试。
- `frontend/src/telemetry/__tests__/routeNames.test.ts`：新增路由名测试。

不修改：

- `mobile/` Flutter 应用。
- 后端 API / DB schema。
- `spec/web_design.html` 设计稿。

---

## 10. Out of Scope

- Flutter 移动端活动列表。
- 新增后端距离筛选参数。
- 活动列表搜索框。
- 列表排序切换。
- 点击月份跳转或折叠月份。
- 在活动详情页新增自定义返回按钮；浏览器返回先满足当前需求。
