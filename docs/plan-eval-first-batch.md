# 首批八份冻结输入：导入、引用与报告

依据 [#1062](https://github.com/zhaochy1990/stride-devops/issues/1062)、
[#1048 决议](https://github.com/zhaochy1990/stride-devops/issues/1048#issuecomment-7094369904)。
这份手册和导入工具不包含真实训练数据、用户账号或凭据；私有输入与输出均留在本机。

## 固定输入

| 文件键 | 项目/目标 | 上海截止日 | 类型 / 已排末周 / 预期首周 |
| --- | --- | --- | --- |
| chaoyi | 全马 2:55:00 | 2026-10-26 | 新建 |
| pan | 全马 3:35:00 | 2026-10-23 | 新建 |
| fm-extra | 全马 3:10:00 | 2026-10-23 | 新建 |
| hm-extra | 半马 1:59:59 | 2026-10-23 | 新建 |
| hm-120 | 半马 1:20:00 | 2026-10-26 | 新建，复用 chaoyi 历史 |
| rolling-c | 全马 2:55:00 | 2026-10-26 | 接续 / 4 / 5 |
| rolling-d | 全马 2:55:00 | 2026-10-26 | 追赶 / 2 / 4 |
| rolling-hm | 半马 1:20:00 | 自身精确冻结时点（目前 2026-11-25） | 接续 / 实际末周（目前 5） / 下一周（目前 6） |

四位跑者的真实测试镜像历史只读导出，经已有 `RunnerSnapshotSchema` 保存逐条活动、比赛、
能力、校准、恢复和覆盖，不把预聚合 ContextSnapshot 替代 Provider 记录。
额外全马和半马的历史完赛选择依据见 #1048；目标成绩是测试请求，不修改原活动。
缺少生成必需输入应拒绝导入/提交；可选缺测仍保留 null，已覆盖空集合保留 []，未覆盖字段不补造数据。

C/D 共用 2026-10-05 起算的全马赛季、同一精确 `as_of`、同一历史和政策包；仅已排周状态不同。
`active_master_plan.content.weekly_docs`、`weekly_plan_weeks` 和 `weekly_plans` 三个读面必须一致，
第 1–4 周真实边界分别为 10-05、10-12、10-19、10-26；D 只有前两周。
半马保留自身 1:20 真实赛季政策和连续完整周文档，不只改全马显示目标；不要求它与
10-26 新建输入的历史逐字节相同，但必须属于同一授权跑者，所有历史不晚于自身冻结时点。
以自身赛季起始周和已排末周核对截止日归属，`expected_start_week = last + 1`；当前真实
Candidate 赛季从 2026-10-26 开始，冻结于 2026-11-25 的第 5 周，接续应从第 6 周开始。

第 4 周必须能回溯到测试库真实周文档，或获授权的隔离环境正常生成产物；保留原文件、
发布 Worker 版本/镜像 digest、赛季身份、生成执行项/Artifact ID、来源和内容 SHA-256。
**不能平移相邻第 3 周处方冒充真实第 4 周。** 只有经确认的实际来源才可进入最终八份验收。

## 私有清单和可重复导入

1. 在私有目录保存八份 `<文件键>.json`，另保存真实原件，不能先拼装成伪原 Artifact。
   C 的原件可分别为 `source-fm-candidate.json`（Candidate 的 `content.weekly_docs` 含 W1–3）
   和 `source-fm-w4.json`（正常 W4 Artifact 的 `weekly_docs`）；HM 使用自身完整 Candidate
   `source-hm.json`。每份原件独立记录哈希。`rolling_sources` 每项支持非空原件数组，
   也兼容一份足够覆盖已有周的单文件引用；读取普通 `weekly_docs` 或 Candidate `content.weekly_docs`。
   快照 `provenance.source` 记录来源证据链和产物哈希；`exported_at` 是原导出时间，重跑不改。
   不把未获得真实来源的第一波初步场景当最终输入。
2. 在该目录生成私有清单。哈希覆盖原文件字节，不重排键、不换行、不重新导出运动历史：

   ```bash
   python3 - <<'PY'
   import hashlib, json, pathlib
   def ref(name):
       p = pathlib.Path(name)
       return {"file": name, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
   keys = ["chaoyi", "pan", "fm-extra", "hm-extra", "hm-120", "rolling-c", "rolling-d", "rolling-hm"]
   manifest = {"schema": "plan-eval-first-batch/v1", "snapshots": {k: ref(k+".json") for k in keys},
               "rolling_sources": {"rolling-c": [ref("source-fm-candidate.json"), ref("source-fm-w4.json")], "rolling-hm": ref("source-hm.json")}}
   pathlib.Path("manifest.private.json").write_text(json.dumps(manifest, indent=2))
   PY
   ```

3. 在 running worktree 安装并构建现有依赖，然后先本机检查（没有网络请求或数据库写入）：

   ```bash
   pnpm install --frozen-lockfile
   pnpm --filter @stride/coach-agent-worker... build
   node src/coach_agent_worker/scripts/import-first-batch.mjs --check "$PRIVATE_DIR/manifest.private.json"
   ```

   工具在任何写入前校验各快照序列化请求的 UTF-8 字节数不超过网关/API 的 16 MiB，并在每项 POST 前再检查；超限修正后可直接重跑，不留下 pending。
   工具校验 canonical 快照结构、四个独立跑者、固定目标与截止日、同一 chaoyi 历史、
   C/D 赛季/时钟、HM 自身实际末周与冻结日、真实周记录边界、内嵌课表和独立课表。每份已有周文档必须在逐份核验哈希的原件中
   找到同一边界且正文完全相同；来源文件哈希不同、周缺口或相邻周平移都会失败。
   该检查不调用模型，**不是实际起始周测量**。

4. 通过授权的隔离 Admin Dashboard 的 loopback 网关导入。`PLAN_EVAL_ADMIN_ORIGIN`
   是本机同源网关 origin，`PLAN_EVAL_ADMIN_TOKEN` 从私有环境载入，不能写进命令行历史、
   公开日志或清单。导入命令不创建任务、不启动 Worker、不发布计划到生产：

   ```bash
   node src/coach_agent_worker/scripts/import-first-batch.mjs --apply \
     "$PRIVATE_DIR/manifest.private.json" "$PRIVATE_DIR/import-state.private.json"
   ```

   工具先回读已发布规则，使用正常管理员 `/snapshots` 和 `/scenarios` API；新建使用
   `weekly_run_days@2/no_run_days@1/race_goal@1/initial_weeks@1`，滚动使用
   `weekly_run_days@2/no_run_days@1/rolling_window@1/catch_up_dates@1`。
   保存服务器分配的随机 UUID、输入文件哈希和服务器保存正文哈希，再预览八条生成请求。
   正常重复执行只回读并核对原引用，保留八份快照及两个场景 ID，不创建重复项，不覆盖编辑。

   私有状态以 0600 文件逐项写入、原子替换，同一状态同时运行会被锁文件拒绝。
   确定的应用层写入前拒绝（验证 422、鉴权 401/403，以及明确的 invalid_json 400）会清除 `pending`，修正后可重跑。
   网络响应丢失、响应正文损坏、未知状态或进程在 POST 后中断会保留 `pending`，重跑停止；管理员须先从目录回读
   确认该项的实际 UUID/哈希，并在私有状态中对账，不能盲目再 POST。部分成功保留进度，
   不删除已导入数据。若进程被强杀，`finally` 不会清理 `<状态文件>.lock`；必须先确认
   原导入进程已经退出，再人工移除该私有遗留锁，随后完成 `pending` 对账并重跑。
   不得自动删除可能仍由活跃进程持有的锁。改变基准使用新的私有状态文件，保留旧任务和旧引用。

## 正常工作台真实批测

- 使用专用隔离 MySQL、RabbitMQ、测评 API 和已发布 Worker；生产数据服务不可达。
  使用共享机器前先 `hold machine`。容量不足时扩容或新建专用实例，保留原证据，不清理共享资源。
- 登录 Admin Dashboard，核对导入状态中的两个场景 ID，一次选中二者；提交前为 2 场景 / 8 执行项。
  只选一个已发布 Agent 版本；八条执行项必须实际经 API、RabbitMQ 和对应镜像运行。
- 逐项核对冻结快照/请求的目标、截止日及身份，再查看 Generate、Artifact、Schema、规则版本和结果。
  C/D 必须从真实 Artifact `window.start_week` 实测为 5/4；半马实测为自身实际末周 +1（当前 6），
  不硬编码与 C/D 相同的赛季/时点。D 课程日期严格晚于截止日。
  不用预期字段替代实际产物，不用测试桩、模板回放或邻周复制替代真实模型生成。
- 保留目标版本真实 `snapshot_not_covered`、模型/内核失败和 Evaluate 跳过原因，其他执行项继续。
  基线失败不意味着平台错误；平台错误和业务不通过分别计数。半马样本不得预筛掉。
- 详情的任务/场景 `summary` 来自后端，同一执行项只计一次。终态
  `pass + fail + error = 8` 且 `running = 0`，各场景计数与对应执行项一致。

## 导出和清理后复核

等待任务终结（包括业务 fail/error）后，详情点击「导出 JSON 报告」，读取 `GET /api/admin/plan-eval/tasks/{id}/report`。
报告 `schema=plan-eval-report/v1`，任务 `status=done`，另用 `result` 表示汇总判定。活动任务返回 409 `task_not_final`，界面禁用下载并提示等待。
服务端逐记录编码到临时文件后才发送响应，读取失败不会返回半份成功报告；临时文件打开后即解除目录引用，下载结束关闭并释放空间。每个 API 实例同时保留一份报告（包括下载期间）；读取详情前先在数据库汇总元数据大小（含 JSON 转义和行开销的保守 64 MiB 预算）；报告上限 4 GiB，超限在响应前返回 413 `report_too_large`，请求/下载最长 5 分钟并响应取消。
历史任务若没有冻结启动信息，报告中的副本数/环境变量名为 0/空，不从当前 Worker 配置推断。

可从报告独立追溯：

- `task_id/id → agent_version → scenarios[].id → executions[].scenario_id/snapshot_id/id`；
- `execution_inputs[执行项 ID]` 的 `request_json/snapshot_json/as_of` 与 SHA-256；
- `executions[].artifact.id → artifact_contents[Artifact ID]`，复核原文字节 SHA-256 和大小；
- `checks[].check_id/version → frozen_rules[].TaskID/ScenarioID/CheckID/Version/Source`。
  version=0 的 schema 是内建 SchemaCheck，而不是 JavaScript 发布版本。

原始 JSON 用字符串保存，先解析报告，再对字符串 UTF-8 字节验哈希，不把正文重新序列化后比哈希。
Schema 无效原文也保留。Generate 失败无 Artifact；Evaluate skipped 仍有具体错因。
环境变量只展示名称，报告没有凭据值。下载文件含真实脱敏历史，不进公开仓库。

等待 Generate 全终结且队列空闲后，在工作台正常清理该版本 Worker，再打开同一任务并再次导出。
终态报告不含每次导出时钟，前后文件 SHA-256 必须一致；详情、Artifact 与规则应仍可回读。
记录实际版本、镜像 digest、任务/执行项/Artifact IDs、两次报告哈希和来源证明作为本机验收证据。
生产 pin 是用户审批门，不在这一步合并。
