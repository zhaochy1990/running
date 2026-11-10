# 运动记录分享海报 · 设计文档

> 状态：POC 定稿，待开票实现 ｜ POC 原型：`stride 仓库 prototypes/activity-share-poster/`（不在本仓库）
> 日期：2026-11-09 ~ 11-10 ｜ 测试数据：赵超毅 & 德华 2026-11-07 训练（真实生产数据，只读）

## 1. 目标与范围

小程序支持把一次运动记录生成分享图片，发到社交媒体（小红书 / 抖音 / 朋友圈）。

- **多图图集**而非单图：用户可勾选导出（默认概览卡+详情长图）
- 已定稿：**概览卡**（小红书 3:4 / 抖音 9:16 / 朋友圈 4:5 / 通用 1:1 四版本，devops#948 铺齐）
- 已 POC 未定稿：详情长图（1080×3191 六节）、轨迹艺术卡、九主题色系库
- 提议待拍板：成就卡、计划 vs 完成卡、月度总结卡、九宫格切图

## 2. 平台比例策略（App 按目标平台出图，用户不手动裁）

| 比例 | 尺寸 | 平台 |
|---|---|---|
| 3:4 | 1080×1440 | 小红书（官方推荐比例）✅ 已定稿 |
| 9:16 | 1080×1920 | 抖音/视频号 ✅ 已定稿（抖音安全区避让见 §3.1） |
| 4:5 | 1080×1350 | 朋友圈（单图展示不裁）✅ 已铺（devops#948） |
| 1:1 | 1080×1080 | 通用兜底 ✅ 已铺（devops#948） |

平台矩阵落在分享页（devops#948）：用户选目标平台 → 出对应比例（`utils/poster.ts` `POSTER_PLATFORMS` 单源），不手动裁。各比例节策略：3:4/4:5 = 地图+四宫格+配速条；9:16 = 全节收进抖音安全区（§3.1）；1:1 高度只够地图（300）+四宫格的最小信息集，配速条/心率卡不画。

## 3. 定稿版式（概览卡）

自上而下（flex column，页脚在文档流内 `margin-top:auto`——与内容物理隔离，不可能重叠）：

1. 品牌行：砺跑 StrideWise + 日期/城市胶囊
2. 课名标题行 + STRIDE 计划课 / 课型 / 完成度 chips
3. **地图 hero 卡**：提亮中文地图 + 配速渐变轨迹（见 §5）+ 起绿点/终红点标记
4. **四宫格等权重大数字白卡**：距离（渐变字，唯一视觉锚点）/ 时长 / 平均配速 / 平均心率
5. **每公里配速条**：细柱，柱色=该公里配速（gradient3 绿慢→红快），最快公里红色描边环；表头「最快 x'xx"/km · 第 n 公里」
6. 【仅 9:16】**心率曲线白卡**：面积曲线 + Z5 阈值虚线
7. 页脚：署名 · 日期 · 品牌 slogan

**风格语言**：暖粉彩渐变底 + 白色圆角卡片 + 渐变大数字；「训练负荷」（非「训练剂量」）；地图不带版权行（attribution 合规见 §7）。

### 3.1 抖音 9:16 安全区避让（devops#948 P6 实测探索）

图文发布后 feed 的 UI 压在图上：右侧按钮栏（头像/点赞/评论/分享/收藏，横行约 x 912-1080、纵向约 y 340-1500）与底部文案区（caption+话题+音乐行，整宽压底约 336px）。避让口径（`utils/poster.ts` `DOUYIN_SAFE_RIGHT=168` / `DOUYIN_SAFE_BOTTOM=336`，保守取整）：

- 正文右缘统一退到 x 864（品牌胶囊/标题/chips/各卡/页脚单列收口，粉彩底仍整幅出血）；
- 页脚上移出文案区（文字基线 y 1568 = 底界 1584 - 16），关键数据（四宫格/配速条/心率卡）整卡不进两遮挡区；
- 版式随之压缩：地图 560→360、心率卡 316→220（`poster.check.mts` 断言全节在安全区内）。

数值为保守实测口径，**真机发布截图校准挂 devops#949 E2E**（票面验收的实机项）。

## 4. 决策记录（含被否方案）

| 决策点 | 结论 | 被否/替代方案及原因 |
|---|---|---|
| 整体风格 | 亮色时尚（粉彩渐变+白卡） | Swiss 灰阶 / Editorial 暗纸底（「太暗发黄不清晰」）；Wrapped 满版渐变 / ZINE 粗野（「还不如前面的」）；guizang skill 仅借鉴设计规范（AGPL 不可复用代码） |
| 地图 vs 纯轨迹 | **真实地图**（用户熟悉度高） | 纯轨迹艺术卡作为独立图类型并存，不在概览卡 |
| 地图源（POC） | **高德瓦片**（`webrd0{1-4}.is.autonavi.com/appmaptile lang=zh_cn style=8`，免 key） | OSM 瓦片中英混排（用户否）；CARTO 现强制 API key；tile.openstreetmap.org 本网络超时（FOSSGIS 镜像 tile.openstreetmap.de 可用但仅作对照） |
| 地图亮度 | 提亮+降饱和+白纱罩（轨迹为绝对主角） | 原色地图太花抢戏 |
| 轨迹粗细 | 13px 彩线+19px 白 casing（9:16 同） | 40/20px 粗线（「特别粗反而不好看」）；9px 过细 |
| 轨迹着色 | **按配速 gradient3**（绿慢→红快，颜色承载信息） | 单一方向渐变（好看但丢信息）——从 v2 版本找回的设计 |
| 距离 vs 其他指标 | **2×2 四宫格等权重大数字** | 距离独大+其他小字（用户否「太难看」） |
| 每公里配速呈现 | 概览卡=细柱节奏条+最快高亮；详情长图=全量表 | 34 行全量表放概览卡（太占位，用户否） |
| 「训练剂量」 | 改「**训练负荷**」 | 与后端 training_load 生产口径一致 |
| 地图版权行 | POC 已移除 | ⚠️ OSM 条款要求 attribution；生产走方案 B（腾讯静态图）或 App 内文案注明 |
| 心率区间数据源 | POC 用 %HRmax 五分法 | 瓦片 blob 的 hlvl 通道仅 0-3 且厂商区间过宽（98% 挤一档）不可用；生产用后端 `activity_zones` 校准数据 |

## 5. 关键技术结论（POC 实证）

### 5.1 地图管线（POC = 瓦片自拼，仅用于验证效果）

- Web Mercator 拼瓦片进 SVG `<image>`，`feColorMatrix saturate≈0.5` + 提亮 + 34% 白纱罩
- **zoom z17**（街道/湖岸细节翻倍）+ bbox padRatio 0.045 → 轨迹撑满卡片
- **GCJ-02**：高德瓦片是火星坐标。`wgs2gcj` 从 mp `utils/coord.ts` 移植；**bbox 必须沿四边 96 点密集采样转换求包络**——只转两个角点会错位 ~240px（偏移非线性）
- ⚠️ **gen 脚本必须自写 tile-manifest**，fit 参数/地图尺寸变更后必须重跑 gen→fetch→截图三连（曾因 manifest 陈旧导致 16 瓦片全 404、地图破碎）
- 瓦片 404 检查纳入出图断言（requestfailed 监听）

### 5.2 数据面

- 详情端点 `GET /api/:user/activities/:labelId?include=timeseries` 一次给全：主指标/天气/feel/segments/zones/timeseries（10 通道降采样 1000 点含 GPS）
- POC 直连生产：COS `stride-timeseries` 私有桶（blob: ts/dist/hr/hlvl/lat/lon，厘秒）+ stride_reader 只读库
- 每公里分段：轨迹 dist/ts 插值求穿越时刻（POC 自算）；**生产必须用后端 segments**（厂商 best_km_pace 与自算值有差，同卡混用会自相矛盾——4:01 vs 4:03 教训，表头必须与表内数据同源派生）
- **多用户**：COS blob + summary JSON（含 userSlug）两件套即可出任意用户的图（已用赵超毅+德华双人验证）

### 5.3 渲染与质量断言（生成后必须自测）

- Playwright 截图（含 fullPage 出长图）；**出 PNG 前跑断言**：内容块 vs 页脚碰撞扫描、瓦片 404、scrollHeight≤画布高、图表行数——全 OK 才出图
- **页脚必须文档流内**（absolute 定位迟早被内容压住——v7.1 事故）；Chrome headless 多实例需各自 `--user-data-dir`
- 输出文件名必须带全部配置维度（`set-overview[-douyin]-<userSlug>-<tilesrc>`）——不同配置互相覆盖是曾致地图碎掉的根因
- 视觉审查（多模态看图）缩略图下读数字不可靠，几何断言以 DOM 实测为准；但**几何正确≠视觉正确**（CSS 规则丢失机检不拦），交付前仍需肉眼过一遍

### 5.4 生产端实现路线（开票输入，三选一）

| 方案 | 说明 | 评估 |
|---|---|---|
| ~~A~~（**spike 否决**） | mp 原生 `<map>` + `MapContext.snapshot()` 截图入 canvas | ❌ 2026-11-10 spike：**`MapContext.snapshot` API 不存在**（typings 3.17.0 + 运行时 3.18.0 双证；含 polyline 与否无从谈起）；includePoints 确定性 fit 与离屏 region 反而可行——详见 `docs/spike/map-snapshot/README.md` |
| **B（spike 后采纳）** | 腾讯位置服务静态图 WebService API | ✅ 服务端直出 PNG；path ≤2048 点/256 条（分段彩色可行）、size ≤1680×1200、scale=2；配额 1 万次/日/Key、5 QPS（个人）；GCJ-02 用 `utils/coord.ts`；Key 走后端代理不进前端包 |
| C | 瓦片自拼（本 POC 方案） | 不推荐生产：高德瓦片非官方授权使用、OSM 国内可达性不稳 |

**P4 详情长图落地（devops#946，2026-11-10）**：mp `utils/posterDetail.ts` 六节 canvas（01 八格总览/02 轨迹/03 配速曲线 3:30-7:00 快=高/04 心率曲线面积+Z5/05 区间横条/06 每公里全量表），缺节数据整卡跳过、序号顺延、总高自适应；配速分段与概览卡同源（poster.ts pacedKmSplits 单源），区间生产用 activity_zones（%max 五分法兜底，POC zones5 口径 <60/60-70/70-80/80-90/≥90），配速曲线通道优先、无 pace 通道时 dist+ts ±8 点推导兜底（POC build-data 同款）；颜色全走九色系 token（同 #947 纪律，ON_ACCENT 白字为 POC 既定口径）。渲染走「多段 canvas 纵向拼接」：每段 ≤1900 逻辑高按 dpr=2 绘制导出，再在 dpr=1 整幅画布 1:1 合成 1080×H（≤4000，经典 iOS 4096px/边限制内留余量；34km≈3600、全马≈3800 单张），超长课按节边界分多张随图集导出；出口在海报弹层平台行最右「详情长图」（devops#947 弹层内切换）。零 hex/九主题颜色闭包/分段与分张规划断言进 `utils/posterDetail.check.mts`（CI npm test 链）；E2E（微信开发者工具真渲染）挂 devops#949。

**B 的 P2 落地（devops#944，2026-11-10）**：Go API 加静态图代理 `POST /api/users/me/poster/map`（`src/go/internal/api/postermap.go` + `src/go/internal/tencentlbs/`），key 走 `STRIDE_WORKER_TENCENT_LBS_API_KEY`（`tencent-lbs:` 配置节，未配 key 时代理返回 503 `map_proxy_not_configured`）。mp 侧 `utils/posterMap.ts` 组装配速分色 path（GCJ-02）+ 起终点 markers，任何失败降级矢量占位（真轨迹 + 配速渐变 +「地图底图暂未开放」角标），其余节正常出图；真图回归待 key 到位后挂 devops#949。

其余生产要点：mp canvas 绘制（同构先例 workout-detail.ts / strategy.ts）；保存相册 util 需新写（全仓零命中，含权限拒绝引导）；主题色系 token 表沿用 `utils/theme.ts` 单源模式；标题超长 ellipsize；配速分段用后端 segments；attribution 方案随地图方案定。

## 6. 迭代史（简要）

v1 纯轨迹 → v2 OSM 真实地图四比例 → v3 guizang skill 双风格（暗系被否）→ v4/v5 亮色系+九主题色库+全量配速表 → v6 大胆双方向（被否）→ v7 多图图集+市场对标（Strava 轨迹首图/NRC 贴纸/小红书攻略）→ v8 用户逐条纠偏（细轨迹/加回地图/四宫格/节奏条）→ v8.5 合并版（v2 的信息密度 × 新版视觉品质，9 处细节）→ v9 高德中文地图+多用户 → **v10 定稿小红书+抖音两版本**。

完整过程与全部中间产物见 `prototypes/activity-share-poster/README.md`（stride 仓库）。

## 7. 遗留与开放问题

1. ~~详情长图未接高德源~~（P4 devops#946 已走腾讯静态图代理，同 P2）；轨迹艺术卡未实现、未接高德源；~~4:5、1:1 未铺~~ 已铺（devops#948，2026-11-10：四比例 + 平台矩阵 + 抖音安全区避让 §3.1，同数据四比例回归进 `poster.check.mts`）
2. ~~九主题色系库（晨光默认/海盐/薄荷冰/星紫/樱花/蜜柚/墨松/绯红鎏金/夜航）待用户砍调（樱花 vs 星紫区分度弱、夜航去留）~~ 已落地（2026-11-10，devops#947）：九套全量保留（票面验收=九套全量出图），POC VARIANTS 迁 `src/wechat-miniprogram/utils/posterThemes.ts`，海报弹层色卡圆点横滑选择器 + 偏好 storage 持久化；dark（夜航）切浅字逻辑随迁；`utils/posterThemes.check.mts` 对账进 CI（poster.ts 零 hex、九主题×四比例全量出图颜色闭包断言）
3. 小程序码是否上海报（拉新入口）未拍板
4. ~~抖音 9:16 安全区（右侧按钮栏/底部文案遮挡）未做针对性避让探索~~ 已做（devops#948 §3.1：保守实测口径常量 + 全节避让断言；真机校准挂 devops#949）
5. ~~方案 A 的三个验证点（见 §5.4）需要一次 spike~~ 已完成（2026-11-10，devops#943）：A 否决退 B，结论与证据 `docs/spike/map-snapshot/README.md`
