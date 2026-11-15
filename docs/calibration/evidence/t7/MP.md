# 小程序训练状态：T7 工程验证

共享输入：`docs/calibration/fixtures/client-display-v1.json`。实际只读链路为隔离 Gin + MySQL + RS256 用户鉴权；测试身份装配仅切换本地 storage / userStore，页面通过原有 service/request 读取真实 API。

`mp-client-display-checks.json` 记录八个实际鉴权 GET 的正文 SHA-256、HTTP 状态及页面展示向量。GET 正文独立读取并计算哈希，逐一核对服务 manifest；页面另行核对中心、快慢范围、单侧方向、证据日期、截止日和上海执行时刻。旧 API fixture 与新 API 的旧版 snapshot 执行日期差别按共享 fixture 的 `server_expected` 解释。

- `mp-two-sided.png`：两侧支持范围、数据质量 / 全力证据 / 模型支持分开显示。
- `mp-constraints-only.png`：中心缺失但单侧速度下界仍明确对应配速 ≤。
- `mp-low-stale.png`：高测量质量不提升模型支持；陈旧心率保留无中心及限制说明。
- `mp-missing.png`：缺快照。
- `mp-help.png`：实际点击“说明”后的整行帮助，经真实滚动检查全文可读、再次点击可收起。
- `mp-error.png`：真实 Gin 用户范围拒绝（HTTP 403）的加载失败态，“重试”实际点击后仍保持诚实错误态；恢复有效身份后页面成功。

图片均为 synthetic 工程测试数据裁剪，只保留卡片与帮助，没有真实用户身份、邮件、活动路线或 token。它们不是算法准确性证据。

本 worktree Node 24 下 `npm ci --ignore-scripts --prefer-offline`、`npm test`、`npm run check` 通过；WechatIDE 的 `compile_wxml` / `compile_wxss` 成功。额外投影边界包括旧 API、未知枚举、来源 JSON 不可用、当前来源缺一指标、不可用心率目标、仅单侧 zones 与 canonical method。
