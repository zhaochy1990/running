# T7 阈值解释验证

本票仅扩展现有训练状态四卡及说明；训练图表和平台既有布局保留。配速定义为当前全力可维持约一小时的能力估计。测量质量、努力程度与估计支持分开呈现；现场心率代理与方法特定实验室 LTHR 分开，旧 v3 估计不称独立检测值。

## 共享工程向量

`fixtures/client-display-v1.json` 是三端组件／投影测试共同读取的合成响应与独立显示字面量。它验证工程行为，不是准确性标签。中心与快／慢端由 Go API 提供整秒 `s/km`，客户端仅拼分钟秒；214.5 和 215.5 的服务端 half-even 输出分别为 214、216 秒。单侧速度下界显示配速 ≤ 慢侧；缺中心不填入旧中心。

向量覆盖双侧范围、仅约束、反向单侧、低支持／服务端陈旧原因、旧 API、缺快照、未知枚举与坏来源。证据日为上海民用日期，数据截止日与 UTC 执行时刻分列；不使用客户端今天或 90 天门限判断陈旧。`legacy.server_expected` 说明：新 API 读取旧来源仍可提供执行时刻，而真正旧 API 响应没有该字段。

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

该脚本不使用 request interception：8 状态实际读取 HTTP body 并与共享 SHA256 比较，在 390px 检查数值／范围／日期、键盘展开说明、无横向溢出，另查桌面及真实断网错误／重试。三端应读取同一最终 manifest；服务重建后必须重测，不能混用旧随机身份的 hash。

## 标准邮件 smoke 与证据

`frontend/scripts/local-smoke.cjs` 在已有邮件登录 → activities → detail → weekly GET 后增加真实 `/training-status` 与说明交互。旧 API/真实账户截图仅存私有目录，不提交。受控合成卡片截图可放 `evidence/t7/`，不含邮箱、真实用户身份、轨迹、备注或 token。

最终实际命令、计数、三端 hash、截图与未覆盖项记录在集成任务的 T7 证据文件；unit/build 不能替代真实客户端走查。生产仍 active3，本票不切换候选、不改生产运动或计划数据、不执行最终留出评分。
