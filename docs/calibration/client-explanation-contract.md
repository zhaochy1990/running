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
