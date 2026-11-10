# 分享海报 E2E 驱动脚本（Epic #601，devops#949 wave 4 收口轮留档）

epic-601 P7 收口轮（2026-11-10，master `a169ae83`）的 DevTools 模拟器驱动 harness，
留档供回归复跑。测试报告与证据见 `docs/e2e/poster-epic601/`。

## 组成

- `mint-sessions.py` — 经本地 auth-backend（`localhost:3001`，与生产同库）为两个真实用户
  铸造 mp 受众会话：用户 A 赵超毅（真实账号、真实活动数据；直登 wave 3 轮换口令，失败回落
  admin reset-password）与用户 B E2E 测试跑者（种子身份）。产出 `session-a.json` / `session-b.json`。
- `eval.py` — 在 appService 里求值一个 `function(){...}`（wechatide `automation_evaluate`）。
- `run_w4.py` — 步骤驱动器：`python3 run_w4.py <step>`，步骤名 a1…b5（见
  `docs/e2e/poster-epic601/README.md` 的矩阵表），结果机器断言追加写 `results.json`，
  出图 PNG 经 base64 分片拉回本机并读 IHDR 校验尺寸。
- `fn/*.fn` — 注入模拟器的 JS 步骤函数模板（`__PLACEHOLDER__` 占位；`run_w4.fn()` 装配前
  会先用 node 做表达式语法校验，防语法错炸进运行时）。

## 复跑前置

1. 本地栈 up（stride-devops/local，含 `stride-api:local-944` 影像或 ≥2026.11.17 的 pin）；
   `stride-devops/test/.env` 可用（admin 与用户 B 口令）。
2. DevTools 打开 `src/wechat-miniprogram`，`wechatide` CLI 可用且已登录。
3. `constants/config.ts` 临时切 `CURRENT_ENV = ENV.DEV`（本地栈）；**跑毕必须还原 PROD**。
4. 复跑顺序：`mint-sessions.py` → a1 → a2 → a3 → a4…b5（a3 之后再跑 a4，弹层必须已打开）。

## 边界（如实）

- 保存到相册在模拟器上会被平台《用户隐私保护指引》前置阻断（fail `api scope is not
  declared in the privacy agreement`）：harness 只断言真实调用发生且错误链路不崩；
  声明补齐后的实机回归见 `docs/poster-release-checklist.md`。
- 地图层在无 key 环境断言 503/404 降级出图；真图回归需 LBS key（同 checklist）。
