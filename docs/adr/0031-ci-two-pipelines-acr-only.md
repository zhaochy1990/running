# CI/CD：一条 PR pipeline + 一条 master pipeline，制品只发 ACR

`running` 的 CI/CD 收敛成两条 pipeline：`ci.yml` 只跑 pull request（frontend / go / coach / contract-parity 四组检查，加一个只构建不推送的 docker dry run）；`release.yml` 跑 master 的每次 push，按三阶段走 —— bump-versions（算出本次 push 触及的制品的下一个版本号，不写任何文件）、build（每个变更的制品在独立 runner 上并行构建并推送）、commit-versions（写 `versions.json`，一个 commit）。版本号状态放在仓库根的 `versions.json`，`paths` 判据放在 `.github/release-packages.json`。原来的 `worker-go.yml` 与 `coach-agent-api.yml` 各自持有 `github.run_number` 的 CalVer、各自持有路径过滤、各自带一份逐字重复的 Renovate job，而且两份路径列表重叠——一次 push 能同时启动两者、并发 commit 到 master。现在只有一条 pipeline 能看到整个 push。

Status: accepted。**Supersedes ADR 0002 的 registry 选择**（GHCR → 阿里云 ACR）。

镜像**只推阿里云 ACR**，不再推 GHCR，也不再推 `:latest`。`stride-devops/versions.env` 是整栈的发布清单，由 `stride-devops` 自己的 `pin-images.yml` 在固定分支 `deploy/pin-images` 上累加更新（先检出已存在的分支再改，所以恒为**一个**待审批 PR）。`running` 的 release workflow 只负责把发布计划 dispatch 过去，不再让 Renovate 从 registry 反推版本。

**为什么不用 Renovate**：版本号在 bump-versions 阶段就已经确定。让 Renovate 去 registry 重新发现一遍，是在 workflow 已知答案的情况下绕一跳 —— 而那一跳带来了 `sleep 30`（registry tag 列表滞后）、3 次重试、`renovate@41` + Node 22 的版本钉死、以及每个生产 workflow 一份的重复 job。实测过 ACR 的 tag 列表 API 可用（Renovate 技术上可行），这是取舍不是能力限制。

Known trade-off：

- **没有 git tag，也没有 GitHub Release。** 镜像 tag 是制品唯一的不可变身份。ACR 个人版会**回收旧 tag**（实测 `stride/stride-worker` 只剩 78 个 CalVer，最早到 `2026.7.48`），所以靠 tag 回滚有一个有限窗口。
- **版本号判据是路径，不是 commit 类型。** 包目录内的 `docs`/`chore` commit 也会触发定版 —— 与原来两个 workflow 的 `on.push.paths` 行为一致，但和只按 commit 类型发版的仓库不同。
- **"会改变产物的路径" 与 "会打破某个检查的路径" 是两个集合。** manifest 只表达前者；检查触发路径写在 `ci.yml` 自己手里。`src/coach_contract/**` 是最清楚的例子：它改的是 coach 两个镜像，但不改任何 Go 镜像，却会打破 Go 的 contract-parity。
- **`src/coach_agent_api/**` 只影响 `stride-coach-api`**，不影响 `stride-coach-worker`（前者的 Dockerfile `COPY` 了 worker 源码，反之没有）。两个 artifact 的 paths 因此不对称。
- 新制品必须在 `versions.json` 里用当前已部署的版本做种，否则编号从 `.1` 重来、被读成降级。
- 发布逻辑的一部分住在另一个仓库（`zhaochy1990/configurations` 的 composite action、`stride-devops` 的 `pin-images.yml`），改那边不会在这个仓库留下 commit。
