# 当前HR支持与未采用历史协议的原因边界

本次只修Spec最终复评确认的剩余P2，base8631a8b2。原081d / b67a / mixed-source-dates
证据、252实际run及first-score保持原样；不重新评分、调参或重复252。

独立同形反例先RED：当前selected HR=170、support=low、有效证据日11-14，却把61日前
未选中的 `stale_HR_support` 放入当前reasons，三端说当前心率支持已过期。当前有效协议+
较新的quality rejection也重现相同原因scope污染。

修复只改解释摘要：

- `hr.reasons` 只说明当前估计；新增optional有界 `hr.rejected_reasons` 保存未采用协议原因。
- 历史日期/拒绝详情保留，不恢复旧中心或支持。当前170/low/有效日期和算法报告均不改变。
- 三端把历史记录明确标为“未采用历史协议（不参与当前估计）”与“未采用协议：…”，不再
  把旧stale或质量拒绝说成当前支持过期。Coach bounded schema/工具保持同义。
- 没有当前有效支持的双日期case仍说缺少独立协议/无法估计，并列出历史过期/质量拒绝；
  没有为了隐藏问题而删除拒绝详情。

实际producer→typed安全摘要→真实MySQL Publish/read在-race下覆盖：当前有效+旧stale、
当前有效+未采用quality、无当前有效+双日期。两种current case均保持170/low/单个selected。
Go producer/API race、calibration/compute/storage/apifmt相关suite与vet通过；科学算法文件无改。

新本地Gin/MySQL/RS256的15份真实HTTP响应由实际Chrome Web和MP public projector读取；
四个相关producer状态另经真实mysql2 DataProvider→Coach工具回读，source/reasons/rejected_reasons
与Go完全一致。Web37tests+build、MP自检/tsc、Swift11tests（8显示+3真实API/session/VM，0skip）、
fresh workspace build与Coach27tests通过。不是新MP/iOS原生UI走查。

只读081d三个既有bounded Source用当前typed reader重投影仍语义相等；该轮无HR协议元数据的输入不会
生成rejected_reasons。既有081d252与73行工程链路只按summary-only无math变动的边界继承，
不声称新252/新73实跑或不同随机ID/时间的HTTP逐字节相同。

本轮服务 `.done` 正常PASS135.87s、Vite停止；storage-only audit确认15个本地身份/bundles
已清理，policy3/4/3。无生产访问、无上线开关改变。准确性仍insufficient、release_ready=false。

已实际查看：[当前170+旧stale](web-producer-current-hr-with-stale-hr.png)、
[当前170+quality拒绝](web-producer-current-hr-with-quality-hr.png)、
[缺支持+双日期](web-producer-stale-hr-mixed-hr.png)。
脱敏hash与范围：[verified-summary.json](verified-summary.json)。
