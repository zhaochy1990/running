# 分享海报 Epic #601 E2E 测试归档（wave 1–4，devops#949 P7 收口）

> 收口轮：wave 4（2026-11-10）。被测代码 = master `a169ae83`（P1–P6 全合并：#725/#727/#728/#729/#730/#731）。
> 本文档整合归档三波既有测试轮（wave 1/2/3，报告留痕于 tracker 票面评论与 stride-devops/test）与 wave 4 终轮，
> 证据目录见 `evidence/`（wave 4 精选）与文末索引（wave 1–3 全量在本机 /tmp 取证目录）。
> 全程无 mock：真实 DevTools 模拟器、真实 auth-service、真实远端 DB（与生产同库）、真实网关/API/worker。

## 结论（先行）

- **生成→保存→分享全链路（真实数据）**：通过。生成四比例 IHDR 精确、保存出口正确调用且被平台隐私声明前置阻断（预期内，见待补验项）、分享预览正确携带真实出图临时文件。
- **真实数据双用户**：通过（wave 4）。用户 A（赵超毅，真实账号 1260 条真实活动）全链路 + 用户 B（E2E 测试跑者，真实 auth 身份）登录隔离 / 数据隔离 / 越权拒绝 / 跨用户状态无泄漏回归。
- **主题切换回归**：通过。九色系切换即重渲、偏好持久化、关层重开恢复、渲染中切主题「最新胜出」无悬挂。
- **地图层降级**：通过。缺 key（本地栈 503 `map_proxy_not_configured`）与生产未部署端点（404）两路均优雅降级出图，其余节正常。
- **待用户侧完成后补验（不阻塞本票收口，步骤见 `docs/poster-release-checklist.md`）**：
  1. **隐私声明**：mp 管理后台《用户隐私保护指引》补声明「保存到相册」→ 回归 S3 直接保存 / S4 权限拒绝引导两场景（当前 `wx.saveImageToPhotosAlbum` 平台层直接 fail，代码链路与错误处理已验证）。
  2. **真图**：腾讯 LBS key 申请 + 上 k8s secrets → 真实静态图出图回归（当前两环境均为降级占位，代理行为已按无 key/伪 key/有效 key 三态在 API 层验证）。
  3. **实机**：真机保存相册 + 小红书/抖音各发布一次的发布验收（模拟器无法代验平台相册与社交 App 实机行为）。

## 各波次范围与结果

### wave 1（2026-11-10 上午）— P3 保存/分享出口场景轮（S1–S9）

- 范围：#945 保存 util + 分享出口的场景矩阵（S1 生成 / S2 预览 / S3 直接保存 / S4 权限拒绝引导 / S5 尺寸等）。
- 结果：S1/S2/S5 通过；**S3、S4 被平台前置阻断**——`wx.saveImageToPhotosAlbum` 同步 fail `api scope is not declared in the privacy agreement`，根因是 mp《用户隐私保护指引》未声明相册写入，非代码缺陷（缺陷评论留痕 stride-devops#945 两评论）。
- 证据：`/tmp/epic601-wave1-mp/`（actionsheet/海报/预览截图、真实保存调用取证）。

### wave 2（2026-11-10 下午）— 地图代理 API 轮 + mp 缺陷发现轮

- API spec：`stride-devops/test/tests/api/user/wave-epic-601.spec.ts`（跨网关真实 HTTP，A/B/C 三块：无 key 503 短路 + 退化体确定性、伪 key 下 400 校验先于上游、真上游拒伪 key 502 且响应/日志零 key 泄漏、401 default-deny、收尾还原）。**wave 4 收口日重跑 8/8 通过（27.3s）**。
- mp 侧发现 3 缺陷（留痕 stride-devops#944 三条缺陷评论）：出图 2× 尺寸偏差（未传 `destWidth/destHeight`）、跨活动陈旧轨迹泄漏（模块级 `mapSegments` 未随 buildView 重置）、地图代理门控错用 pause 段数（真实活动永不触发）+ 连带发现 `fetchPosterMapImage` 动态 import 运行时悬挂。
- 修复轮：running PR #728（merge `04b0abb8`）全部修复并回归通过（IHDR 1080 精确、跨活动逐字节一致、代理请求真实出现在 network、503/404 均降级出图）。证据 `/tmp/e2e-944-fix/`、`/tmp/e2e-944-reg/`。

### wave 3（2026-11-10 22:18–22:46）— 全量回归轮（最终 master，PROD 环境随包配置）

- 环境：master `a169ae83`（P1–P6 全合并），mp `CURRENT_ENV=PROD`（发布配置原样），真实微信登录（DevTools 账号 oauth/token 交换），单用户赵超毅。
- 覆盖：34km 真实 GPS 跑步 / 12k 跑步 / 力量训练三类活动；四比例出图；九色系逐一；渲染中切主题竞态；详情长图六节逐节取证（心率/配速/每公里表/全量表裁片）；保存与预览出口 instrumentation；`POST /api/users/me/poster/map` 打到生产 `api.stride-running.cn` → **404（生产 api 2026.11.15 无该端点，pin PR devops#935 待批）→ 地图层降级占位，出图正常**。
- 证据：`/tmp/e2e-601-w3/`（113 文件：步骤函数、出图 PNG、六节裁片、network 三份、会话铸造脚本）。

### wave 4（2026-11-10 23:05–23:14）— P7 收口轮：真实数据双用户 + 主题回归 + API 层重跑

- 环境：同一 master；mp 临时切 `CURRENT_ENV=DEV`（指向本地栈 `127.0.0.1:8082`：stride-api:local-944 影像含代理端点 + 与生产同库的远端 DB + 本地 auth-backend），跑毕已还原 PROD 并刷新模拟器（主检出零残留）。本地栈 = **pin PR devops#935 部署后、key 配置前的生产行为等价环境**。
- 会话：双用户均经真实 auth-service 密码授予铸造（`tests/e2e/poster/mint-sessions.py`；用户 A 复用 wave 3 轮换口令，用户 B 用种子口令），无任何 stub。
- 步骤与结果（全绿，机器断言见 `evidence/wave4-results.json`）：

| # | 步骤 | 断言 | 结果 |
|---|------|------|------|
| A1 | 注入用户 A 真实会话，清主题偏好 | storage 就位 | ✅ |
| A2 | 34km 真实 GPS 跑步详情（本地栈+远端 DB） | 页面加载、`hasMap=true`、70 段 polyline | ✅ |
| A3 | 打开海报弹层 | 弹层可见、九色系（sunrise/ocean/mint/lavender/sakura/citrus/forest/festive/midnight）、四平台（小红书 3:4 / 抖音 9:16 / 朋友圈 4:5 / 通用 1:1）、首渲完成 | ✅ |
| A4 | 四比例出图 IHDR | 3:4→1080×1440、9:16→1080×1920、4:5→1080×1350、1:1→1080×1080（四张 PNG 已归档） | ✅ |
| A5 | 主题切换 + 持久化 | midnight/sakura/lavender/sunrise 逐一切换：`posterThemeKey`、label、storage 三态一致且即重渲；关层重开恢复 sunrise | ✅ |
| A6 | 渲染中切主题竞态 | 长图渲染中 t+1.2s 切 midnight：终态 midnight、路径就位、无悬挂（「最新胜出」补渲逻辑回归） | ✅ |
| A7 | 详情长图 | 1080×3526，宽度精确 | ✅ |
| A8 | 力量训练（无 GPS）出图 | 1080×1440 正常出图（无轨迹不炸、占位不出地图） | ✅ |
| A9 | 保存出口 | 真实调用 `wx.saveImageToPhotosAlbum`，携带真实出图临时文件；平台返回 fail `api scope is not declared in the privacy agreement`（**预期内，待隐私声明补验**），错误链路不崩 | ✅（平台门） |
| A10 | 分享出口 | 真实调用 `wx.previewImage`，urls=生成海报临时文件 | ✅ |
| A11 | 地图代理（network 全量） | 12 次 `POST /api/users/me/poster/map`（真实轨迹点）全部 503 `map_proxy_not_configured` → 降级占位出图（`evidence/wave4-postermap-summary.json`） | ✅ |
| B1 | 同一 JS 会话切换用户 B（真实身份） | 会话就位 | ✅ |
| B2 | B 的活动列表（真实 API） | 空列表「暂无活动记录」——B 看不到 A 的任何活动 | ✅ |
| B3 | B 直接 URL 访问 A 的活动 | `notFound=true`（default-deny，无越权读取） | ✅ |
| B4 | 主题偏好作用域 | `poster.theme` 为设备级 storage（P5 既定设计：同设备跨账号共享审美偏好，非活动数据泄漏） | ✅ |
| B5 | 同一 JS 会话切回 A（不刷新模拟器） | 海报以 A 数据重渲成功、主题=持久化值——wave 2 陈旧状态缺陷类（跨用户变体）无复发 | ✅ |

- API 层重跑：wave 2 spec 8/8（见上）。

## 已知边界（如实）

- 模拟器 ≠ 实机：相册写入、社交 App 分享行为最终以实机为准（checklist 第 6 步）。
- 生产 `poster/map` 404 属预期（端点未部署）；devops#935 合并部署后应变为 503（无 key）→ 配 key 后 200 真图。三态都有明确断言口径。
- 用户 B 无真实活动数据（远端 auth DB 中唯一可登录的其他身份是种子测试账号），故 B 的「生成」维以数据隔离/越权拒绝/无跨用户状态泄漏覆盖；「生成→保存→分享」全链在用户 A 的真实数据上完整走通。为 B 造活动数据会违反无伪造数据原则，未做。

## 证据索引

| 波次 | 位置 | 内容 |
|------|------|------|
| wave 1 | `/tmp/epic601-wave1-mp/` | S 场景截图、保存失败取证 |
| wave 2 | `stride-devops/test/tests/api/user/wave-epic-601.spec.ts`；`/tmp/e2e-944*` | API spec（仓内留档）；缺陷与修复轮取证 |
| wave 3 | `/tmp/e2e-601-w3/` | 最终 master PROD 环境全量回归（113 文件） |
| wave 4 | 本目录 `evidence/` + `/tmp/e2e-601-w4/` | 双用户终轮机器断言与出图（精选入仓，全量留本机） |
| harness | `tests/e2e/poster/` | wave 4 驱动脚本（可复跑） |

## 复跑方式

```bash
# 前置：本地栈 up（stride-devops/local），DevTools 打开 src/wechat-miniprogram，
# constants/config.ts 临时切 ENV.DEV（跑毕还原 PROD），wechatide 已登录。
python3 tests/e2e/poster/mint-sessions.py          # 铸造双用户真实会话
python3 tests/e2e/poster/run_w4.py a1_inject_a     # 按序逐步骤执行（a1→a2→a3→a4…b5，
python3 tests/e2e/poster/run_w4.py a2_detail_34k   # a4 及之后依赖 a3 已打开海报弹层）
```
