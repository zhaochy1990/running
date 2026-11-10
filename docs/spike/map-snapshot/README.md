# Spike：分享海报地图方案 A 三验证点（mp 原生 map snapshot）

> 票：zhaochy1990/stride-devops#943（Epic #601 P1）
> 日期：2026-11-10 ｜ 结论：**方案 A 否决，退方案 B（腾讯静态图 API）**
> 证据：`evidence/spike-results.json`（自动化运行时数据）、`evidence/simulator-page.png`（开发者工具模拟器截图）
> 复现 harness：`src/wechat-miniprogram/spike/map-snapshot/`（已排除出产物包，含复现步骤）

## TL;DR

方案 A 的前提 API **`MapContext.snapshot()` 不存在**——不是"截图不含 polyline"，而是**原生 `<map>` 在 webview 渲染下没有任何官方截图通道**。三验证点中 V2 可行、V3 部分可行（仅 region 计算），但缺了 V1 这块基石，方案 A 整体不成立。P2 直接按方案 B（腾讯位置服务静态图 API）设计。

## 验证环境

- 微信开发者工具模拟器，基础库 **3.18.0**（项目 `libVersion 3.0.0`，模拟器按最新库跑）
- webview 渲染（本项目未启用 Skyline；运行时 `getSkylineInfoSync()` 返回 `isSupported:false, reason:"a-b test not enabled"`）
- 驱动方式：`cli auto` + `miniprogram-automator`，读 `page.data().results` + 整页截图

## 三验证点结果

### V1 snapshot 是否包含 polyline —— **FAIL（API 不存在，问题比预想更根本）**

四层证据互相印证：

1. **官方类型定义**：`miniprogram-api-typings@5.2.3`（其 API 定义自 5.2.2/2026-07-27 起同步至基础库 3.17.0）中 `MapContext` 接口无 `snapshot` 方法；全量 d.ts 中 snapshot 只存在于 `LivePlayerContext` / `LivePusherContext` / Skyline `Snapshot.takeSnapshot`。
2. **官方文档**：MapContext 方法列表（`developers.weixin.qq.com`）无 snapshot 条目。
3. **运行时**：基础库 3.18.0 下 `typeof wx.createMapContext('map').snapshot === 'undefined'`，`wx.canIUse('MapContext.snapshot') === false`；实例方法枚举共 35 个（getCenterLocation/getRegion/getScale/includePoints/moveToLocation/.../setBoundary/executeVisualLayerCommand，完整清单见 evidence JSON），无一为截图。
4. **结论推论**：webview 渲染下原生 `<map>` 无法被 `canvas` 重绘、无法被 selectorQuery node 化、无组件级 snapshot——设计文档 §5.4 对 A 的想象大概率来自 **Skyline `<snapshot>` 组件 / `Snapshot.takeSnapshot`**（`canIUse('Snapshot.takeSnapshot')` 为 true），但那是 Skyline 专用：需要把页面迁移到 Skyline 渲染并用 `<snapshot>` 包裹子树，属于渲染引擎迁移级别的改动，且 Skyline 下 map 截图对原生层的支持仍需另行验证——均超出"零成本"预期，不作为 A 的续命路径。

### V2 缩放/中心确定性 —— PASS

`MapContext.includePoints({points, padding:[20,20,20,20]})`（地图 `enable-scroll/zoom/rotate/overlooking` 全关）：

- 连续两轮 fit 后 `getRegion()` 读数**完全一致**：SW(31.21565, 121.53916) / NE(31.22555, 121.55953)
- region 完整包含轨迹 bbox（lat 31.21660~31.22460, lng 121.54340~121.55529）且四周留白
- 判定：禁交互 + includePoints 的确定性出图控制**可用**（若 V1 成立，此路可走）

### V3 离屏可行性 —— 部分可用（snapshot 部分无从验证）

- 地图 `position:fixed; left:-10000px`（保持渲染、不在视口）：`includePoints` + `getRegion()` 正常工作，读数与在屏一致量级 → 离屏状态下地图逻辑层可用
- 离屏 snapshot：**N/A**（V1 已证 API 不存在）

## 退路方案 B 调研（腾讯位置服务静态图 API）

| 项 | 数据 | 对海报场景的含义 |
|---|---|---|
| 端点 | `https://apis.map.qq.com/ws/staticmap/v2/`（GET 返回 PNG；仅 HTTPS） | 服务端/客户端均可直出，天然契合"生成流程独立于页面" |
| path 路径点 | **最少 2、最多 2048 个 location**，最多 256 条路径；样式 `color`（支持 32 位 ARGB）/`weight` | POC 的 1000 点降采样轨迹可直接放入；按配速分段可用多路径实现彩色轨迹 |
| markers | 官方支持（start/end 标记可用） | 起绿点/终红点可落地 |
| 图片尺寸 | `size` 宽 50~1680、高 50~1200；`scale=2` 时按 size×2 出图（scale=2 建议 size ≤ 900×900） | 概览卡 hero 图 3:4/9:16 的地图区域 ≤1080 宽即可满足 |
| 配额 | **10,000 次/日/接口/Key**，并发 5 次/秒/接口/Key（个人开发者基准，超额可向官方申请提额） | 分享海报按用户触发，量级远低于配额；需配 Key 管理 |
| 坐标系 | 腾讯系 GCJ-02（与 mp `<map>` 一致） | 生产轨迹 WGS84 需过 `utils/coord.ts` 的 `wgs84ToGcj02`（POC 已验证密集采样求包络的做法） |

方案 B 的已知注意点（P2 设计时处理）：

1. path 的 2048 点上限 vs 1000 点 timeseries 降采样——已兼容，但要按"URL 长度"复核（GET URL 过长可能被网关截断，必要时进一步抽稀或改 POST/分批）
2. Key 属于敏感配置，不能硬编码进小程序包（前端调用会把 Key 暴露；应走后端代理拼 URL 或云函数）
3. 配速渐变轨迹 = 多条相邻 path 分色，注意每条 path 最少 2 点且颜色段衔接
4. 免费配额 5 QPS 在分享高峰（如赛事后）可能触顶，需要 429 退避

## 对 P2 的输入

1. 地图层实现按**方案 B**：后端（或客户端经后端代理）拼静态图 URL，返回 PNG 后进 canvas 与其余海报元素合成
2. `includePoints` 的确定性 fit 逻辑（V2 证据）不浪费——静态图 API 的 `center+zoom` 换算可复用同一套 bbox+padding 思路（WGS84→GCJ-02 用本仓 `src/wechat-miniprogram/utils/coord.ts` 的 `wgs84ToGcj02`，即 POC `wgs2gcj` 的正源）
3. Skyline 路线（`<snapshot>` 组件）仅在未来整体迁移渲染引擎时再评估，不阻塞本功能
4. 复现 harness 与证据已归档，P2 实现时如需在真机复核（本 spike 为模拟器环境），按 `src/wechat-miniprogram/spike/map-snapshot/README.md` 步骤注册页面即可
