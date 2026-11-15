# 校准读端解释契约

Go API 是此 DTO 的 owner，workout / weekly-plan schema 不承担校准元数据。Web、小程序和 iOS 仅可选解码新字段，旧响应仍可读。

`GET /api/{user}/stride/zones` 和 `/health` 均以当日上海日期调用 storage 的 active bundle，一次一致性读取得 policy、snapshot 与对应 zones。GET 只读；query 中的 `mode` / `algorithm_version` 不能改变 active 选择。registry 的相对训练目标也读取同一 active bundle。

`threshold` 保留原有 speed、pace、HR、confidence、日期和 ID 字段，新增 `algorithm_version`、UTC `computed_at`、`selection`、`source`、`fingerprint` 和 `speed_range_pace_per_km_sec`。`/health` 新增 `calibration`，包含同一选择和来源元数据，不改变 `rhr_baseline` 规则。

- `selection` 表达 requested/effective version、policy revision、selected/fallback/unavailable 与原因。只在 preferred 快照行不存在时允许 fallback；已有中心为 null 的 constraints-only 行仍是有效选择，不能补入 v3 中心。
- `source` 是有界 typed 摘要，含方法、目标语义、measurement quality、effort support、support、证据日期、数据截止日、独立活动/日支持、范围意义及降级原因。不输出原始 SourceJSON、观测曲线、坐标或 notes。
- `source.speed.evidence_date` / `source.hr.evidence_date` 是实际支持证据的上海日期；`data_cutoff_day` / `as_of_date` 是输入截止日；`computed_at` 是执行时刻，三者不能互相替代。`event_date_retrospective` 不承诺严格历史当时可得性。
- speed 范围原始单位为 m/s。服务端将高速度转换为 `fast` 配速、低速度转换为 `slow` 配速，整数秒/km 按 `apifmt.PacePerKmSec` 的 half-even 规则舍入；无侧保留 null。`bound_kind` 是 `two_sided` / `speed_lower_bound` / `speed_upper_bound` / `unavailable`。单侧速度下界对应配速慢侧上界，不能展示成双侧范围。这些是支持／敏感性范围，不代表 95% CI。
- HR 的 `target_type=field_HR_proxy_not_physiological_LTHR` 表达场地代理，不是生理实验室阈值；`lab_method_specific_LTHR` 需要保留具体方法。旧 v3 训练估计不表示独立实验室参考。
- 旧行没有来源时 `source.state=legacy_source_missing`，坏 JSON 为 `source_unavailable`。缺快照保持 `threshold:null`、空 zones；响应顶层 `selection` / `source` 解释 `snapshot_unavailable`。不能用未来快照补历史，也不能在 GET 里校准、迁移或补库。

本次仅落可选 wire 类型，T7 负责产品展示及真实 Web／小程序／iOS UI 验收。工程测试通过不改变生产 active=v3 或候选 `release_ready=false`。

## 客户端数值与协议显示

配速中心与快／慢边界仍由 Go API 用 half-even 生成整秒，三端只拼分钟秒。心率 wire 保留正数小数，中心与有效支持范围端点显示为最接近整数，恰好半点向上（166.5→167、168.5→169）；这与 JavaScript `Math.round`／Swift 正数 `.rounded(.toNearestOrAwayFromZero)` 一致，不采用配速的 half-even。此项仅显示，不改持久化值或算法。

HR `method=field_30min_last20_v1` 表示30分钟现场测试的后20分钟，不等于实验室生理LTHR；`lab_lthr_report_v1` 表示实验室乳酸阈值报告，仍保留具体 `lab_method`。努力等级 canonical 为 `probable_maximal`（可能全力），不能把它当未知，也不因测量质量通过就提高能力估计支持。共享 producer-field-half / producer-lab-half 向量由真实 Go候选计算与 SummarizeSource 产出；其中HR范围端点专用于显示舍入边界，不是算法输出的不确定性。


## 兼容和未采用协议（2026-11-16 最终评审修复）

三端只解释 `source.schema_version=1` 且 `state=available` 的支持/质量/努力字段。
未知未来 schema 保留已有中心值，来源标签保守降级，不借用已知 v1 的高支持语义。

`source.hr.latest_rejected_evidence_date` 是最近未采用协议的上海日期，与实际支持的
`evidence_date` 分开。具体 stale / rejected / quality 原因沿用有界 categorical reasons；
三端显示“最近未采用证据日”和陈旧原因。该字段不恢复中心、范围或支持计数，也不刷新
有效证据日期；不暴露原始 HR、私密备注或完整诊断。共享 `producer-stale-hr` 来自实际
Go evidence producer → typed summary → 持久化解析；真实隔离 MySQL 另有回读验证。


混合未采用协议时，`latest_stale_evidence_date` 单独表示最近陈旧协议日；
`latest_rejected_evidence_date` 仍表示最近的任何未采用协议日。近期质量拒绝不能覆盖较旧的
stale日期。两日相同只显示一次日期；不同则分别显示“最近陈旧协议日”和“最近未采用证据日”。
已知突变/恢复/测量异常的质量原因有具体说明，两日都不能被解释为有效支持或复活中心。
没有协议的来源不生成该optional字段；旧JSON缺字段保持缺失，不从最近拒绝日推断stale日。
