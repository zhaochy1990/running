# #990 iOS 合成只读验收

这些图片来自真实 DEBUG iOS App → APIClient/URLSession → 本地 Gin → 隔离 MySQL 的合成账号，均不含真实用户身份、轨迹、备注或凭据。它们只证明工程展示，不是准确性或候选上线依据。

- 自有 Simulator：iPhone SE3 / iOS18.5，375pt，默认字号及 AccessibilityXXXL。
- Swift：389 tests / 58 suites 全绿，含八案原始HTTP SHA256、正常 JWT 会话验证与训练状态五端点模型、真实连接拒绝。
- UI：StridewiseCalibrationSmoke 实际 5 tests / 0 failures / 0 skips：two-sided 帮助与三日期，AccessibilityXXXL 帮助触摸/定义可见且无水平溢出，constraints-only 无中心，missing 无快照，low-stale 心率陈旧原因。
- 八案都有真实启动卡片截图；upper-only / legacy / unknown / source-unavailable 只完成 API/模型断言和截图查看，没有把它们计为已执行专门按钮交互的 UI case。
- 真实网络连接拒绝只验证 repository 错误传播；页面网络错误/重试 UI 尚未验收。来源活动不可访问时仅展示有界摘要，不请求详情，完整页面仍可加载。
- generic iOS Simulator app build 全绿。CUA 因宿主 Mac 锁屏不可用；交互证据来自原生 XCTest，而非伪装的点击记录。

| case | 配速 | 范围 | HR | final 服务原始响应 SHA256 |
| --- | --- | --- | --- | --- |
| two-sided | 3:34 | 支持范围 3:34–3:36 /km | 166 | `359f851c8764d11146474ccc7565fd3d5ffb3c7beb6774c1c8f951b0b4e460bb` |
| constraints-only | — | 至少可达到 4:10 /km（配速 ≤ 4:10） | 166 | `a6728e88b6f885878b42bb283f2cf6ba61c2597e09c1cf75cc2240d61a14cf4b` |
| upper-only | — | 配速 ≥ 4:10 /km（仅单侧约束） | 166 | `380dfa1e38bf521f5d4315932a3831c569962b6bd35705453ad6c99b3207f165` |
| low-stale | 3:34 | 支持范围 3:34–3:36 /km | — | `49ebf30364e7813f2233aa3921782f13adad65bc9d35e5b3959972a0de587729` |
| legacy | 3:34 | — | 166 | `2f9acdf9c0efb02489ffb248ddfac7fd7fac25cc36bd648c07fe052cebc6f60f` |
| missing | — | — | — | `ccebde478116a839fbe3a2869e6f6aec2d09c1b92c2b4535ec11df5938492cce` |
| unknown | 3:34 | 支持范围 3:34–3:36 /km | 166 | `d4cda968e0139cdf8a62a3a23e42a85fa6b6d42ca13d25cdb4fdaf8b2f030aaf` |
| source-unavailable | 3:34 | — | 166 | `d7b81c3b5a1081d0dd46285e2b4c02a0121823c33cdfee8da32f013cd9875546` |

证据日 2026-10-01、截止日 2026-11-14、执行日上海 2026-11-15 00:30 各自保留，缺失时不推造。新 API 的 legacy 源仍可能有执行时刻；旧 API fixture 不含该字段，另测兼容。

`*-cards.png` 是同名合成 case 的阈值卡裁剪；`threshold-help-three-dates.png`、`threshold-accessibility-text.png`、`constraints-only-no-center.png`、`missing-snapshot.png`、`low-support-stale-hr.png` 是 XCTest 原生截图。完整 xcresult、私有 manifest 和 token 不提交。

本票 parity 增量 5 aligned / 0 confirmed / 1 pending；pending 是既有 iOS 没有小程序 zones 表，未由 agent 擅自确认。它不改变本票阈值语义测试结果，也不构成全域 parity 通过声明。
