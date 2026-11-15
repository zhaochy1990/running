# 固定校准离线回放（#984）

[冻结评估协议 v1](evaluation-protocol-v1.md) 已先于候选实现提交，且链接到 SPEC #982。T1 的 segments_only / candidate 均明确是 `v3_alias`，默认生产 `ModelVersion=3` 与全部现有调用保持不变。

在 `src/go` 执行：

```sh
go build -o /tmp/stride-calibration-replay ./cmd/stride
/tmp/stride-calibration-replay calibration replay \
  --manifest internal/compute/calibration/testdata/replay-v1.json \
  --code-version "$(git rev-parse HEAD)" > /tmp/calibration-report.json
```

预期退出 2，结构化状态 `insufficient`。0 保留给完整验收；输入/hash/分割/解码失败退出1。重复命令结果逐字节相同，无生成时间/随机ID。命令只读本地 JSON/JSON.gz，不加载 DB 配置、不初始化 storage 或网络客户端、不写生产。

## Manifest

结构定义为 `internal/compute/calibration/replay.go` 的 `ReplayManifest`；合成 fixture 是可运行的 schema 示例。JSON 严格拒绝未知字段与尾随内容。

- manifest：`schema_version=1`、精确 `as_of`、`source_version`（来源版本+原始文件hash）、activities/health/cases。
- 每活动保留完整 `Activity`（Samples/Laps 经现有 calibrationsource/storage/tsstore 只读接口获取），用 `ReplayContentHash(activity)` 计算内容摘要，针对 Go 解码后的 domain JSON，独立于文件空白/键序。
- `event_time` 是活动事件时刻；`ActivityDate` 仍为上海民用日期的 UTC 午夜表示，两者必须同日。`available_at` 指该内容版本含全部laps/samples的可得时刻；`availability_evidence` 引用不可变历史证明，不能用今天的 updated_at 伪造。未知使用 null/空字符串；设备未知明确 `unknown`。
- `root_activity_id` 归并活动/派生片段，固定 train / validation / final_holdout。同一 source LabelID 不得换根，同根不得跨split；按用户校验事件边界严格有序。
- case 固定用户、`prediction_as_of`、`mode`（strict/event_date_retrospective）、可选 `target_root_activity_id`。预测仅使用 train，validation/final/目标活动及派生物全部排除；活动与健康行均按事件/可得时间过滤。预测日按上海日归入校准域，availability 用精确时刻。
- 独立 `reference` 元数据不进入预测payload/input hash；晚补标签只在 available_at <= report as_of 后评分。真实/全力/质量/协议必须人工审计，不能由课名、feel或模型输出猜测。

报告包含 manifest/input/协议/v3源hash、来源/代码/参数版本、策略真实身份、用户/活动/设备/场景/标签分布及缺失、strict final 与 strict validation 分开评分。配对交集报告用户等权中位数/P90/偏差；各版本另报覆盖与缺失。至少2用户才生成固定seed的用户组bootstrap差值区间。HR与跨时长评分尚未支持，显式记录 unsupported，不据此发布。

每个分层的 `activities` / `users` 计入该层全部 eligible 独立目标活动/用户，包括无预测输出者；各版本 `available` / `missing` / `coverage` 以此为分母。`paired_activities` / `paired_users` 单列三版本共同输出的独立样本数，误差只在该交集评分。完全缺输出的层仍保留，误差为 null。总体 `eligible_activities` / `paired_activities` 分别报告全部目标与交集活动，`users` 为参与配对评分的用户数。同一目标的重复 prediction case 不增加独立计数。

canonical协议在docs，Go内嵌副本只供编译后报告hash；测试强制两者相等。修订必须新建协议版本。

## 工程验收与缺口

| 验收 | 证据 / 状态 |
|---|---|
| 策略与生产v3冻结 | 公开入口snapshot与8场景pre-change golden相等；源hash门禁；alias身份明确 |
| 重复回放 | 合成CLI与受控252活动各两次完全相同，均退出2 |
| 个人旧值容差<=0.01 s/km | snapshot speed=3.9914；pace=250.53865811494714；与SPEC250.53866差<0.000002。原始未round best60片段为250.53935555710208，明确区分 |
| 防泄漏 | 未来活动、晚到活动/健康、未知可得时间、晚补标签、heldout派生物、跨split/换root回归通过 |
| 真实11/15/多用户 | 已完成固定11/15回放及27用户只读审计，见[数据审计](data-audit-2026-11-15.md)；独立参考与严格可得时间仍不足 |
| strict历史回测 | 旧导出252活动均缺不可变availability证明，只允许event_date_retrospective |
| 独立60min/HR标签 | 旧导出无标签；数值/分层/最小N协议已冻结，真实参考不足 |
| 准确性与推进 | T2–T5未实现，两离线策略仍alias；T1真实证据验收尚不完整，不据此解锁T2 |

原始导出/manifest/重复报告只存受控位置，不入Git。公开摘要只给数值/hash/缺口。完整准确性/分层发布gate与未支持HR/跨时长评分须在独立验收完成；本票测试全绿不等于批准发布。
