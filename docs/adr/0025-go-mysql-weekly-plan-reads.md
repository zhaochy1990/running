# Go weekly-plan reads use one content-versioned MySQL table

本周课表从 Python 的 content store、Azure Table 和 SQLite 聚合迁移到 Go `cmd/api` + MySQL。新 API 不复制旧接口的文件目录概念，而是以规范化的上海自然周名称读取当前生效课表；同一张表兼容只读 legacy Markdown 和当前结构化 JSON，并保留 draft/active/archived 生命周期。

## Decision

### API

Go 提供两个新接口：

```text
GET /api/{user_id}/plan/weeks
GET /api/{user_id}/plan/weeks/{week_name}
```

Admin Dashboard 另有一个窄写入口：

```text
POST /api/{user_id}/plan/weeks/{week_name}
```

该入口只接受独立 Admin audience 且 `role=admin` 的 JWT；普通用户 JWT 和
internal token 均返回 `403`。请求体包含 `content`（`weekly-plan/v1`）与
`replace_existing`。目标周已有 active 时，未显式确认替换返回
`409 weekly_plan_exists`；确认后在同一事务中把旧 active 改为 `archived`、
清空其 `status_slot`，再插入新的 active。新记录使用新的 `plan_id`，因此
`revision` 从 1 开始。该入口是管理员导入已在 Dashboard 严格校验的完整计划，
不替代面向运动员的 draft/review 流程。

`week_name` 是派生的可读标识，严格使用 `YYYY-MM-DD_MM-DD`，表示 Asia/Shanghai 下周一至周日的自然周；跨年示例为 `2026-12-28_01-03`。数据库只存 `week_start`，不存 `week_name` 或 `week_end`。非法名称返回 `400 invalid_week_name`，该周没有 active 课表返回 `404 weekly_plan_not_found`。

两个接口只读取 `active`：列表返回所有过去、当前和未来的 active 课表，按 `week_start DESC` 稳定排序且首版不分页；详情返回完整内容。draft 和 archived 不通过这两个接口暴露。响应包含 `plan_id`、`week_name`、`date_from`、`date_to`、`master_plan_id`、`status`、`content_version`、`revision`、`created_at` 和 `updated_at`；列表不返回 `content`，详情根据 `content_version` 将 `content` 返回为 Markdown 字符串或 JSON 对象。这两个课表资源接口不混入 activities、执行统计、feedback、variants 或 scheduled-workout 状态；独立的周聚合 API 与周反馈归属见 ADR 0028。

旧 Python `GET /api/{user_id}/weeks[/{folder}]` 在消费者迁移期间保留，不做服务端兼容转发。

### Storage

```text
weekly_plan
  plan_id         VARCHAR(36)  PRIMARY KEY       -- server-generated UUIDv4
  user_id         VARCHAR(64)  NOT NULL
  master_plan_id  VARCHAR(36)  NULL              -- soft ownership reference
  week_start      DATE         NOT NULL          -- Shanghai Monday
  content_version TINYINT      NOT NULL          -- 1=Markdown, 2=structured JSON
  content         LONGTEXT     NOT NULL
  status          VARCHAR(16)  NOT NULL          -- draft | active | archived
  status_slot     VARCHAR(8)   NULL              -- integrity only: active | draft | NULL
  revision        BIGINT       NOT NULL
  created_at      DATETIME(3)  NOT NULL
  updated_at      DATETIME(3)  NOT NULL

  UNIQUE (user_id, week_start, status_slot)
  INDEX  (master_plan_id)
  CHECK  (content_version IN (1, 2))
  CHECK  (content_version = 1 OR JSON_VALID(content))
  CHECK  (status IN ('draft', 'active', 'archived'))
  CHECK  (
    (status IN ('active', 'draft') AND status_slot IS NOT NULL AND status_slot = status) OR
    (status = 'archived' AND status_slot IS NULL)
  )
  CHECK  (revision >= 1)
```

MySQL 没有部分唯一索引，因此 `status_slot` 仅用于强制每个用户每个自然周最多一个 active 和一个 draft；archived 可有多行。业务逻辑只读取 `status`，API 不返回 `status_slot`。`master_plan_id` 可空：有赛季训练计划的课表保存软引用，健康跑等独立课表为 NULL；不加外键，赛季训练计划归档也不级联改变本周课表状态。

`revision` 属于每个 `plan_id`，从 1 单调递增。内容或状态变化都会递增 revision 并更新 `updated_at`；相同内容和状态的重复请求不变。未来写接口以 `plan_id + expected_revision` 做乐观并发控制，冲突返回 409。

### Content and lifecycle

`content_version=1` 保存非空 Markdown；`content_version=2` 保存结构化 JSON 对象，必须包含 `sessions` 和 `nutrition` 数组，可选 `notes_md`。结构化内容沿用当前 session、workout 和 nutrition 字段，但迁移时递归删除所有 `schema`、顶层 `week_folder` 和 session 的 `scheduled_workout_id`。周身份只存在于外层记录。session/nutrition 日期必须落在该自然周，`(date, session_index)` 唯一，同一天最多一条 nutrition；计数字段为整数，度量字段可为有限 number 或 null。

draft 是内容完整、尚未启用的候选课表；active 是该自然周当前生效的课表；archived 是同周旧 active 被新 draft 替换后的历史快照。同周最多一个 draft。调整 active 时创建或更新 draft，不直接修改 active；启用在一个事务中将旧 active 归档、draft 启用，并保持各自 `plan_id` 不变。新未来周也先创建 draft，必须显式确认，不按日期自动启用。过去周的所有状态均不可再调整或启用；周结束后仍未启用的 draft 可物理删除。赛季训练计划状态变化不影响关联课表。

### Migration

迁移只处理 `src/migration/src/users.js` 中的真实用户，默认 dry-run，显式 `--apply` 才写入。所有选中记录写为 `active`、`revision=1`，生成 UUIDv4；重跑按 `(user_id, week_start, active slot)` 识别已有记录并保留其 ID，不覆盖冲突。

同周同时存在 Azure canonical WeeklyPlan 和 Blob `plan.md` 时只迁移结构化 JSON；仅缺少 canonical 记录时才迁移 Markdown。生产只读审计发现 80 个重叠周，其中 79 个 Table JSON 与同周 `plan.json` 规范化后完全一致，70 个 Table `source_hash` 与当前 Markdown 字节哈希一致，证明重叠主要是同一课表的两种表示，而不是两份并行课表。被结构化 JSON 覆盖的 Markdown 不迁移或合并。

非周一至周日、日期重叠、无法唯一归属自然周或赛季训练计划归属有歧义的 legacy 记录不自动修正，写入迁移报告后人工处理。结构化记录使用 Azure Table `updated_at` 同时初始化 created/updated；Markdown 使用 Blob `last_modified`；缺失可靠时间同样人工处理。

## Consequences

- v1 Markdown 和 v2 JSON 是同一逻辑资源的互斥表示；新计划使用 v2，但当前/未来的 v1 仍可通过 draft 流程用新 Markdown 整体替换。
- `week_name` 不再承载阶段标签，阶段归属通过可空 `master_plan_id` 表达。
- variants、生成模型来源、活动实际值和设备推送状态明确不属于本表或这两个读取接口。
