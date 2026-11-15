# iOS review3：独立评审修复后的真实复验

这是一份新版本证据，旧目录截图与 v2 哈希保持原样。独立 Spec review 在79f10f5f发现的 iOS HR半点差异已经修复；工程复验不代表独立复评已经完成，也不改变候选release_ready=false。

HR wire保留小数，展示使用正数最近取整、半点向上：中心166.5→167，范围166.5–168.5→167–169；与Web/MP一致。配速仍消费Go提供的整秒，未改配速舍入、算法或校准值。

新增producer-field-half / producer-lab-half的HR中心、协议与努力语义由真实Go EstimateOfflineWithEvidence→SummarizeSource→storage Publish→Gin产生；两案配速中心与范围为nil，不补旧值。HR范围端点另标 synthetic_wire_rounding_boundary_not_model_uncertainty，**仅是wire显示边界，不是算法估计的置信区间或准确性证据**。

本次真实 v3 manifest 有10案、新合成身份/JWT与正文hash。Swift全套392 tests /58 suites全绿，包含十案真实APIClient原始HTTP SHA256、普通JWT bootstrap/五端点页面模型及共享oracle中hr_range/hr_method_label/speed_effort_label/lab_method。generic Simulator build通过。

原生XCTest完整8 tests /0 failures /0 skips，62.498s，自有iPhone SE3/iOS18.5/375pt。保留原6项（two-sided说明/三日期、AccessibilityXXXL、constraints-only、missing、low-stale、真实网络失败→重试恢复），新增现场167/实验室169及167–169显示、真实协议、具体lactate_turnpoint、质量门槛、可能全力的实际按钮与滚动断言。upper-only/legacy/unknown/source-unavailable没有新增专门原生交互测试，不把API/VM核对冒充10个UI案例。

第一次环境尝试因19891代理未启动而中断，未计通过；重启代理并核对真实producer响应hash后完整重跑才得到上述8项通过。UI故障开关仅让zones上游真实连接关闭端口1，不生成校准HTTP数据；teardown恢复后再逐案GET确认10份hash均不变。

| case | wire HR | Swift显示（共享oracle） | 协议标签（共享oracle） | 实际正文SHA256 |
| --- | --- | --- | --- | --- |
| two-sided | 166 | 166 | — | `01f5da2ac894896d07efdc3376c8b5eb9d8a7464636e2c4ec28c3adfc71b704b` |
| constraints-only | 166 | 166 | — | `2bdddea2adbcedae7a3ad3dd0f4bcf5017c349594e2c51bff38bee785f92385c` |
| upper-only | 166 | 166 | — | `93c309ef0d20e5e4875ba914703f7ead7bc325735b33cd73d3f27e965543a67a` |
| low-stale | — | — | — | `fe66b008367447621c8db619dc72020944879517b7414413d3bb05de6760d81f` |
| legacy | 166 | 166 | — | `613a9055a1a0fe077a87c60e55744a845ac904338f8d6f9ef29bcc2ddb039015` |
| missing | — | — | — | `92e0b7de42131b8c6054076bf46999cf80325200053f43e605c77f3f610ccaf1` |
| unknown | 166 | 166 | — | `b63d4e01ef467cbef672e5773b2930cb05dbdb21b682eab6fbfd832bc85c206e` |
| source-unavailable | 166 | 166 | — | `e35df6ea94ea33c69939b7dfcc30b3eaecc64037fa26f5f55e984099288115a4` |
| producer-field-half | 166.5 | 167 | 场地测试协议（30分钟测试的后20分钟） | `475a8ba2b870e639c41ba1251e8b4e2b2083426d1f5fd25f782c04b5355462d1` |
| producer-lab-half | 168.5 | 169 | 实验室乳酸阈值报告 | `78308fec3f4e486c1771587e5856e9c074a37707a70ffb3c35490d34492e4dd5` |

[response-checks.json](response-checks.json) 只保存合成wire摘要、预期字面量与实读hash，不含JWT/用户ID。12张PNG均由本次原生XCTest产生，真实用户资料、完整xcresult及私有manifest不提交。截图已实际查看；现场/实验室帮助保留方法与目标语义，可能全力没有降成未知。

Parity依据修复后review3实测更新为5 aligned /0 confirmed /1 pending；pending仍是既有iOS无zones表差异，agent未代用户确认。独立Spec曾FAIL的历史保留，新独立复评由总任务单独完成。
