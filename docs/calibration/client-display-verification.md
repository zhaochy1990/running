# T7 阈值解释验证

本票仅扩展现有训练状态四卡及说明；训练图表和平台既有布局保留。配速定义为当前全力可维持约一小时的能力估计。测量质量、努力程度与估计支持分开呈现；现场心率代理与方法特定实验室 LTHR 分开，旧 v3 估计不称独立检测值。

小程序当前的阈值卡片采用 T7 前的简洁布局，显示指标名称、短标签、数值和单位。现场测试结果仍使用「现场心率参考」。下文的小程序说明交互与 T7 截图记录的是当时的界面。

## 共享工程向量

`fixtures/client-display-v1.json` 是三端组件／投影测试共同读取的合成响应与独立显示字面量。它验证工程行为，不是准确性标签。中心与快／慢端由 Go API 提供整秒 `s/km`，客户端仅拼分钟秒；214.5 和 215.5 的服务端 half-even 输出分别为 214、216 秒。单侧速度下界显示配速 ≤ 慢侧；缺中心不填入旧中心。

向量覆盖双侧范围、仅约束、反向单侧、低支持／服务端陈旧原因、旧 API、缺快照、未知枚举与坏来源。证据日为上海民用日期，数据截止日与 UTC 执行时刻分列；不使用客户端今天或 90 天门限判断陈旧。`legacy.server_expected` 说明：新 API 读取旧来源仍可提供执行时刻，而真正旧 API 响应没有该字段。

T6（#1000，2026-11-16）扩展四类演进 v4 向量（`evolved-low-evidence`／`evolved-prior-only`／`evolved-measured-reference`／`evolved-unavailable`，由真实 `StrategyEvolvedCandidate` 估计器 + `SummarizeSource` 产出并 deep-equal 锁定，含五态标签、`algorithm_revision` 与模型敏感性范围）、历史 v4 行（`historical-v4`：无修订标记、无逐指标状态，三端保持旧读法）与两条按用户覆盖披露（`override-selected`／`override-fallback`：真实 resolver 的 selection 形状，含 `override_snapshot_missing` 回退）。`expected` 新增共享字面量键 `pace_state`／`hr_state`／`pace_algorithm_label`／`override_label`／`override_fallback_label`／`hr_joint_label`，Web／小程序／iOS 断言同一组中文文案（五态大白话、联合估计标注、「当前有效算法」与按用户选择披露）。生产端展示仍只读，不调用 publish/recompute。

## 真实本地服务

`src/go/internal/api/calibration_client_server_test.go` 是默认跳过的显式测试 harness，使用现有 `api.NewService`、GIN、真实 RS256、MySQL storage 与 `tsstore.FileStore`。DSN 必须是 root / TCP `127.0.0.1:13383` / `stride_983_test`，否则在迁移前拒绝；无生产 fallback。所有 SQL 均在 storage。独立随机用户通过公开 storage API 建立和删除；仅隔离数据库暂设 active4，退出恢复原 policy 值。

`STRIDE_990_CLIENT_SERVER` 指向受控私有 manifest 路径时才启动，监听 `127.0.0.1:19890`。manifest 权限为 0600，含各状态的测试身份、短期签名 token、实际 Go 响应、SHA256 与预期向量。不要提交或打印该文件。测试结束创建 `<manifest>.done`，使 Go 测试正常退出、清理用户并恢复 policy；不要直接 kill 代替清理。

生产 `/api/users/me` 属于 auth-service。为完成三端正常本地 session bootstrap，harness 仅在测试进程组合一个同路径身份适配：真实验签后按 JWT sub 从 MySQL 读取合成 profile，返回 id/display_name。它不进入生产服务，不代理生产 token，不伪造 zones 响应，也不代替真实邮件登录验证。

在 `src/go` 运行（DSN 在测试进程环境中单独配置）：

```sh
STRIDE_990_CLIENT_SERVER=/tmp/stride-983/private/t7-client-server.json \
  go test ./internal/api -run '^TestCalibrationClientServer$' -count=1 -v -timeout 190m
```

Vite 仅注入公开的 `VITE_DEV_API_PROXY=http://127.0.0.1:19890`，使用独占端口 5184。凭据／token 只进入 smoke Node 进程，不能注入 Vite 的 `STRIDE_*` 前缀。

在 `frontend` 运行：

```sh
STRIDE_990_CLIENT_MANIFEST=/tmp/stride-983/private/t7-client-server.json \
STRIDE_990_SCREENSHOTS=/tmp/stride-983/private/client-smoke \
STRIDE_LOCAL_URL=http://127.0.0.1:5184 node scripts/calibration-client-smoke.cjs
```

该脚本不使用 request interception：8 状态实际读取 HTTP body 并与共享 SHA256 比较，在 390px 检查数值／范围／日期、Chrome 合成触摸与键盘展开说明、无横向溢出，另查桌面及真实断网错误／重试。三端应读取同一最终 manifest；服务重建后必须重测，不能混用旧随机身份的 hash。

## 原生错误／重试网络故障

`TestCalibrationNetworkProxy` 是另一个默认跳过的 `_test.go` 工具，仅监听 loopback19891。它透明转发到上述真实19890服务；`POST /_test/zones-failure` 的 `{"enabled":true}` 只令 zones 请求连接关闭的本机端口1，由真实网络错误产生502，身份/profile等仍转真实服务；`false`恢复正常。它不替换校准数据，恢复前后正文SHA256相同。控制路由不进入生产 API。

```sh
STRIDE_990_PROXY_CONTROL_FILE=/tmp/stride-983/private/t7-network-proxy.json \
  go test ./internal/api -run '^TestCalibrationNetworkProxy$' -count=1 -v -timeout 130m
```

只在 DEBUG Simulator 私有配置使用19891，并用原生 XCTest 操作失败页、关闭故障、点击重试。结束创建 `<proxy-file>.done` 正常退出代理，再完成主服务done清理。两个工具重跑前先移除各自旧done标记，不能把默认skip记作验收。

## 标准邮件 smoke 与证据

`frontend/scripts/local-smoke.cjs` 在已有邮件登录 → activities → detail → weekly GET 后增加真实 `/training-status` 与说明交互。旧 API/真实账户截图仅存私有目录，不提交。受控合成卡片截图可放 `evidence/t7/`，不含邮箱、真实用户身份、轨迹、备注或 token。

最终实际命令、计数、三端 hash、截图与未覆盖项记录在集成任务的 T7 证据文件；unit/build 不能替代真实客户端走查。生产仍 active3，本票不切换候选、不改生产运动或计划数据、不执行最终留出评分。
