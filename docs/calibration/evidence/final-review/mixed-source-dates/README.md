# F3混合协议日期补充验证

这是对最终评审F3的最后一条混合边界修复。上层原081d / b67a报告、新252实际日志、
日期/hash/234.69s结果均保留，不改写为后续字段已被那轮执行覆盖。

反例为实际Go producer中的61日前有效胸带协议，加一份更近但心率突变/恢复质量不合格的
协议。原摘要仅有最近未采用日，较新的拒绝遮住旧stale日期；纯producer反例先RED再GREEN。
现有两个不同字段：`latest_stale_evidence_date` 对应旧stale日，`latest_rejected_evidence_date`
对应最近拒绝日。混合共享向量实际输出分别是2026-09-14 / 2026-11-13，cutoff11-14；
HR中心仍nil、support=none、有效证据日为空、evidence_count=0。摘要不保存raw HR/notes。

单一stale时两日期相同，三端只显示“最近陈旧协议日”一次；混合时分别显示两日期，并显示
“心率存在突变或恢复，协议未采用”等具体原因，不把新近质量拒绝日挂在过期原因下。

- 实际 producer→typed安全摘要→真实隔离MySQL Publish/read mixed回归在 `-race` 下通过。
- 新本地Gin/MySQL/RS256的13份HTTP响应由Web实际Chrome浏览器、MP public projector、
  Swift真实APIClient/session/TrainingStatusModel读取，每份响应hash一致。Web35tests与
  build、MP自检/tsc、Swift11tests（含3 live/0skip）、fresh workspace build与Coach26tests通过。
- 全普通Go suite、相关producer API/calibration race和vet通过。全API既有AdminBalances
  race边界仍按上层原报告，不冒称全域race通过。
- 只读原081d新252报告的三个已经持久化的bounded Source，用当前typed reader重投影，
  语义逐一相等，新字段均omitempty。构造逻辑只从明确协议的stale reason赋值，所以没有
  独立协议的该轮输入不新增stale日期。这只证明相应有界来源结构继承；不是新252实跑，
  不称不同随机ID/执行时间的新HTTP正文与旧run逐字节相同。不重新评分或调参。

新API `.done` 正常PASS132.77s、Vite停止；storage-only audit确认13个本地身份与snapshot/
zones清理，policy恢复3/4/3。没有生产访问或上线开关改变。准确性仍insufficient、release_ready=false。

已实际查看新卡片：[混合两日期](web-producer-stale-hr-mixed-hr.png)、
[同日去重](web-producer-stale-hr-hr.png)。脱敏hash：[verified-summary.json](verified-summary.json)。
