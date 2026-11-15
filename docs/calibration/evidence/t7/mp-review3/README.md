# 小程序 review3 / v3 验证

独立轮次，保留旧八案证据的原始响应哈希，不覆盖旧文件。共享 fixture `96e74ff0`；本轮十种状态全部通过实际 MySQL → Gin / JWT → 小程序 service/request → 页面读取。每种状态另以实际鉴权 GET 正文计算 SHA-256，并与 v3 manifest 核对，均为 HTTP 200。

`mp-client-display-checks.json` 保存本轮十案的独立实测哈希、实际页面显示、三日期、源码哈希及新增 HR 帮助交互结果。两个 producer 状态的中心/协议/effort 来源于实际 Go producer：场地 HR 166.5 → 167、实验室 HR 168.5 → 169；共享 range 半点边界仅验证有效 wire 展示（167–169），不表示算法区间经过统计校准。配速中心缺失仍为缺失。

四张裁剪 PNG 只含 synthetic 卡片与帮助。`producer-*-cards.png` 展示可能全力、整数 HR 范围及实验室原始方法；`producer-*-hr-help.png` 是真实点开 HR 说明、滚动并读取渲染文案后的截图，分别准确说明30分钟测试后20分钟和实验室乳酸阈值报告。两者再点击收起也通过。来源摘要、截止日、上海执行时刻全文可读。

本 worktree Node24：35条 `npm test` 自检、共享十案 public projector、`tsc --noEmit` 和 `git diff --check` 通过。`probable_maximal`、field/lab协议均有实际 RED → GREEN；不支持的 likely 别名保守显示未知。HR 正数 `.5` 沿用向上取整。

本轮未重跑既有403负路径，未另测320px/全部动态字号。现有 zones 平台差异保持原记录。全部材料是工程展示验证，不是准确性证据。

临时 loopback DEV 身份装配只切换私有signed JWT/storage/userStore，未注入假API响应；测试后清除身份、逐字恢复app/config并只关闭owned窗口s6。共享v3服务保持由总implementer管理。
