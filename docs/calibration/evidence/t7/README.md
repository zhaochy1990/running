# T7 三端阈值解释：合成工程验收

所有公开图片与向量来自隔离 MySQL + 真实 Go GIN + RS256 的合成测试身份，不含真实用户邮箱、轨迹、备注或 token；不构成算法准确性或候选上线证据。服务重建前 v1 已单独私有归档，本文只引用同一最终响应：[八案 HTTP SHA256 与显示向量](final-response-hashes.json)。

| 状态 | Web | 小程序 | iOS |
| --- | --- | --- | --- |
| 双侧范围 | 页面与 hash | 页面与 hash | 专门 UI 断言、HTTP/VM、截图 |
| 仅约束、缺中心 | 页面与 hash | 页面与 hash | 专门 UI 断言、HTTP/VM、截图 |
| 单侧速度上界 | 页面与 hash | 页面与 hash | HTTP/VM、真实启动截图 |
| 低支持／陈旧 | 页面与 hash | 页面与 hash | 专门 UI 断言、HTTP/VM、截图 |
| 旧来源 | 页面与 hash | 页面与 hash | HTTP/VM、真实启动截图 |
| 无快照 | 页面与 hash | 页面与 hash | 专门 UI 断言、HTTP/VM、截图 |
| 未知枚举 | 页面与 hash | 页面与 hash | HTTP/VM、真实启动截图 |
| 坏来源 | 页面与 hash | 页面与 hash | HTTP/VM、真实启动截图 |

Web 在 Chrome 390px 模拟视口检查无水平溢出，实际执行合成 touch tap、键盘 Enter 展开与收起帮助，另查桌面、真实 offline 失败与恢复后重试；未测试实体手机或 Safari。小程序在自有开发者工具窗口真实触摸帮助、滚动全文、收起，并以真实 Gin 403 验证错误／重试／恢复有效身份。iOS 原生 XCTest 5 项零失败、零跳过，包含说明、三日期与 AccessibilityXXXL；真实网络连接拒绝仅测 repository 传播，**iOS 错误界面／重试 UI 未验收**。

- Web：[390px 卡片](web-threshold-390.png)、[桌面完整说明](web-threshold-help-desktop.png)。
- 小程序：[场景、交互与六张截图](MP.md)、[独立实际 HTTP／页面检查](mp-client-display-checks.json)。
- iOS：[13 张真实启动／XCTest 截图及精确覆盖](../../../walkthrough/devops-990/ios/README.md)。既有无 zones 表差异保留 pending，未由 agent 代理确认。
- [共享向量](../../fixtures/client-display-v1.json)、[复跑方法](../../client-display-verification.md)、[iOS 本地只读装配](../../../../ios-app/docs/calibration-read-smoke.md)。

实际本地检查：Web 29 focused tests 与 build；小程序 35 条自检与 typecheck、WXML/WXSS 编译；Swift 389 tests / 58 suites、generic simulator build；iOS 原生 UI 5 tests / 0 failures / 0 skips。协议质量门槛、真实 publisher 缺锚点原因及“当前来源缺 HR 对象”另以 TDD 验证，不冒充新增真实服务案例。小程序 canonical 枚举追加仅投影／单测，公开 source hash 如实保留当时实际采集字节，既有八案显示没有改变。

标准真实邮件 smoke 完成登录、activities/detail、weekly GET、training-status 及说明，但严格整体结果 **FAIL**：周力量 GET 404 在同账号、同生产服务、`origin/master` 原页面与原脚本基线同样复现；一次 watch 502 定位为本机 DNS 失败，后续未再出现。阈值目标路径单独 PASS，不以此掩盖整体失败。真实用户截图与诊断只保留私有目录，未为测试创建正式计划或修改生产。

生产仍 active3，本票不启用候选、不回填生产，不读取最终 holdout/outcomes 或运行最终评分。
