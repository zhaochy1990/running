# 分享海报发版时序 Checklist（Epic #601 P7，devops#949）

> 固化于 2026-11-10（master `a169ae83`，P1–P6 全合并）。代码侧已完成并有四波 E2E 留痕
> （`docs/e2e/poster-epic601/`）；**三项用户侧前置未完成**，各自带补验口径如下。
> 标注【用户】的步骤属管理后台 / 生产部署 / secrets 操作，须由用户执行，agent 不代办。

## 当前状态快照

| 项 | 状态 | 留痕 |
|----|------|------|
| P1–P6 代码（spike/概览卡/保存分享/长图/主题/四比例） | 已合并 | PR #725/#727/#728/#729/#730/#731 |
| E2E wave 1–4（真实数据、双用户、主题回归、API 三态） | 全绿 | `docs/e2e/poster-epic601/README.md` |
| ① mp 隐私指引声明「保存到相册」 | **未完成（用户）** | devops#945 两条缺陷评论；wave4 A9 |
| ② 生产 pin PR（stride-api/worker 2026.11.17） | **待审批（用户）** | stride-devops#935 |
| ③ 腾讯 LBS key + k8s secrets | **未申请（用户）** | devops#943 spike 结论、#949 票评 |
| 生产 poster/map 现状 | 404（端点未部署，降级出图属预期） | wave3 network 取证 |

## 发版时序（按序执行，①必须早于④⑤）

### ①【用户】mp 管理后台：《用户隐私保护指引》补声明「保存到相册」

- 位置：mp.weixin.qq.com → 设置 → 服务内容声明 → 用户隐私保护指引 → 新增「保存到相册」
  （`scope.writePhotosAlbum`）对应的信息收集声明，提交审核通过。
- **补验（声明生效后，实机或 DevTools 均可）**：
  - S3 直接保存：活动详情 → 顶栏分享海报 → 保存到相册 → 首次弹隐私授权 → 同意 → 相册出现
    1080 宽 PNG（口径同 wave4 A9，当前阻断证据 `saveImageToPhotosAlbum:fail api scope is not
    declared in the privacy agreement` 应消失）。
  - S4 权限拒绝引导：设置中关闭相册权限 → 保存 → 应弹「去设置」引导（openSetting）→ 打开开关
    → 重试保存成功。
  - 长图多张：选超长活动（如 34km）出长图保存 → 多张串行保存全部成功。

### ②【用户】生产后端部署：审批合并 stride-devops#935 并上线

- 合并 pin PR（stride-api / stride-worker → 2026.11.17）→ CVM 上 `./up.sh`。
- **补验（部署后）**：
  ```bash
  # 无 token：401（default-deny 挂载即可证端点已存在）
  curl -s -X POST https://api.stride-running.cn/api/users/me/poster/map \
    -H 'Content-Type: application/json' -d '{}'            # → 401
  # 带真实用户 token、无 key：503 map_proxy_not_configured（不再是 404）
  ```
  - mp（正式/体验版）出图抽检：有 GPS 活动 → 地图层「底图暂未开放」占位 + 其余节正常（与
    本地栈 503 行为一致，wave4 A11 口径）。
- 回退：revert devops#935 + `./up.sh`（versions.env pin 回 2026.11.15）。

### ③【用户】腾讯位置服务 key 申请 + 上 k8s secrets

- 申请：lbs.qq.com → 应用管理 → 创建应用 → 添加 key，启用 WebServiceAPI（静态图）。
  个人基准配额 1 万次/日/key、5 QPS；域名白名单留空或填服务端出口（key 只在服务端用，绝不进前端包）。
- 上 secrets（stride-devops 仓，devops PR 流程）：
  1. `.env` 增加 `STRIDE_WORKER_TENCENT_LBS_API_KEY=<key>`；
  2. `k8s/scripts/create-secrets.sh` 分类器纳入该键（先例：WeChat Pay 接线 commit `57284c2`
     「stride-secrets keys + api/worker env blocks」）；
  3. api/worker deployment env 增加同键引用 → `create-secrets.sh` 刷新 → 滚动重启。
- **补验（key 生效后，真图回归）**：
  - API：真实轨迹体 POST poster/map → **200**，响应是 PNG 且 IHDR = 请求
    `width/height × scale`；响应与日志无 key 值（泄漏口径同 wave2 spec B2）。
  - mp 出图：有 GPS 活动的海报地图层出现真实中文底图 + 配速渐变轨迹（绿慢红快、起绿终红），
    角标不再出现；力量活动仍为占位（无轨迹不打代理）。
  - 降级路保留验证：临时清 key（或未配 key 环境）仍 503 → 占位（回归 wave2 spec A 块）。

### ④ mp 发版（海报入口随包上线）

- DevTools 上传（版本号递增，备注含「分享海报」）→ mp 后台提交审核 → 发布。
- 发布前自查：
  - `constants/config.ts` `CURRENT_ENV = ENV.PROD`（已满足，master 现值）；
  - request 合法域名已含 `https://api.stride-running.cn`（线上既有能力，无需新增）；
  - 依赖顺序：**①隐私声明必须已通过审核**（否则正式版保存路径仍被平台阻断）；
    ②建议已部署（未部署也不阻塞：404 降级出图已在 wave3 验证）；③可后补（缺 key=占位）。

### ⑤【用户】发布验收（票面口径）

- 生产真实数据出图抽检：任选真实 GPS 跑步 + 力量训练各一条，四比例 + 长图出图正确
  （尺寸/主题/数据与本人记录一致）。
- 小红书实机发布一次 + 抖音实机发布一次：保存到相册 → 发布，检查安全区避让（抖音 9:16
  顶部状态栏/底部导航区不裁关键内容）。

### ⑥ 收口

- 以上全绿后：devops#949 勾验收 → Epic #601 勾 P7 → 归档（E2E 报告已在仓内）。

## 异常口径速查

| 现象 | 含义 | 处置 |
|------|------|------|
| 保存 fail `api scope is not declared...` | ①未生效 | 等 mp 后台声明过审，非代码缺陷 |
| poster/map 404 | ②未部署 | 合并 devops#935 并 up.sh，降级出图属预期 |
| poster/map 503 `map_proxy_not_configured` | ②已部署、③未配 key | 正常降级；配 key 后转 200 |
| poster/map 502 `map_proxy_upstream_error` | key 无效/配额超限/上游故障 | 核对 key 与 lbs 控制台配额 |
| 出图 2160 宽 | 回归到 2× 偏差（已修复） | 对照 wave2 缺陷 1，重查 destWidth/destHeight |
