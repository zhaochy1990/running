---
name: worktree-development
description: 必须在 running 项目中任何可能修改仓库内容的开发任务开始前使用，包括 feature、bug fix、refactor、测试、文档、配置、设计和生成文件。先为当前任务创建并切换到全新的 Git worktree，再在其中完成探索、实现、测试、验证、review、commit 和 push，避免污染启动 checkout。
---

# Worktree-first development

## 硬性不变量

每个新的写入型任务必须使用一个专属的新 worktree。启动 checkout 只用于开启会话和纯只读操作，不得在其中修改项目文件。

同一个任务的连续对话复用该任务的 worktree；新任务不得复用旧任务的 worktree。

本 skill 必须保持自包含且跨 coding agent 可移植（Claude Code / OpenCode / 纯 shell / CI 皆可）：不调用、加载或委托任何其他 skill，也不要求先运行其他 slash command，更不依赖任何 agent 专用工具或 API。唯一入口是本 skill 随附的 `scripts/create_worktree.py`（仅用 Python 标准库 + `git` CLI）。它从启动 checkout 创建任务专属 linked worktree + 分支，并在同进程内加载同目录可信 `scripts/initialize_worktree.py` 完成 SQLite 快照。

## 开始任务

1. 在读取任务相关实现文件、安装依赖或修改任何项目文件前，先判断当前任务是否已有本会话为它创建的 worktree。
2. 若当前任务尚无 worktree，先确保 cwd 是启动 checkout 的仓库根目录，再运行唯一入口。name 用根据任务目的生成的 3–5 词 kebab-case，例如 `fix-training-load-dates`：

```bash
python ".claude/skills/worktree-development/scripts/create_worktree.py" fix-training-load-dates
```

   该脚本：校验 kebab-case（3–5 段、小写 alnum、单连字符）；从当前 repo 的 git common-dir 定位 primary checkout（仅支持标准 linked worktree 布局，即 common-dir 为 `<primary>/.git`；`--separate-git-dir` 等非标准布局 fail closed 报 unsupported）；在 primary 下已 ignore 的 `.worktrees/<name>`（agent-neutral 目录，不用 `.claude/worktrees`）创建 worktree，分支固定 `worktree-<name>`；**base 默认解析为启动 checkout 当前 `HEAD` 的固定 commit OID**（任务连续性：从 primary 或任意 linked worktree 调用都基于"你现在所在的那个 commit"，不依赖可能 stale 的 `origin/HEAD`），可用 `--base-ref` 覆盖但正常流不需要；拒绝已存在的 path 或 branch（含 dangling symlink/junction），不静默复用；`.worktrees` 父目录若是 symlink/junction 或逃逸 primary 则拒绝。creator 的**所有** ref/checkout 变更（branch 创建、`worktree add`、失败时的 branch rollback 删除）以及 initializer 内的裸 git 命令都带 checkout 加固，共用**同一个**可信空 hooks 临时目录：`core.hooksPath` 指向该空目录、`core.fsmonitor=false`、并把所有 effective filter driver 的 `clean`/`smudge`/`process` 置空（passthrough）+ `required=false`（effective filter 只枚举一次，且此前已 assert local config safe），因此**配置的 checkout hooks（含 `reference-transaction`）与 filter driver 不会在 worktree 创建、初始化或 rollback 时执行**。initializer 在跑任何 `status`/evidence 之前，先用不展开 include 的 raw local-config 检查 fail closed（见下），确保 include.path armed 的 filter 不会在 evidence 阶段被触发。此外，creator 与 initializer 的**每个** git 子进程都用净化过的环境运行：屏蔽 system/global git config（`GIT_CONFIG_NOSYSTEM=1` + `GIT_CONFIG_GLOBAL` 指向可信空文件），并剔除所有可改变 repo 发现/对象/index/worktree/config 源或让 git 执行外部命令的继承变量（`GIT_DIR`/`GIT_WORK_TREE`/`GIT_COMMON_DIR`/`GIT_INDEX_FILE`/`GIT_OBJECT_DIRECTORY`/`GIT_ALTERNATE_OBJECT_DIRECTORIES`/`GIT_NAMESPACE`/`GIT_CEILING_DIRECTORIES`/`GIT_DISCOVERY_ACROSS_FILESYSTEM`/`GIT_PREFIX`/`GIT_CONFIG*`/`GIT_CONFIG_KEY_*`/`GIT_CONFIG_VALUE_*`/`GIT_CONFIG_PARAMETERS`/`GIT_EXTERNAL_DIFF`/`GIT_SSH*`/`GIT_ASKPASS`/`GIT_EDITOR`/`GIT_SEQUENCE_EDITOR` 等；保留 `PATH`/`HOME`）。repository-**local** config 仍读取（git 运行所需），但在建 branch 前 fail closed 拒绝任何 local `include.path` / `includeIf.*`（含 `includeIf.gitdir:**/worktrees/**` 与 `includeIf.onbranch:*`；检测用 `git config --local --get-regexp` 不展开 include）以及 `extensions.worktreeConfig=true`；local 显式 filter driver 一律 neutralize。`.worktrees` 父目录在 branch 创建前、`worktree add` 前、add 成功后都做目录 identity（resolved path + lstat st_dev/st_ino）复核以侦测意外替换；**注意**：这是同一 OS 账户下的尽力侦测——git 不提供 dir-handle/no-follow 原语，无法抵御同用户恶意进程在 syscall 窗口的竞态；侦测到不一致即停止、不自动清理 outside 路径、保留现场并报 CRITICAL。创建后在 creator 进程中直接加载同目录可信 initializer 并对新 worktree 绝对路径调用 `run(new_path)`（绝不从新 worktree 的 target branch 加载脚本；加载时暂禁 bytecode 写入，不在启动 checkout 留 `__pycache__`）。base OID 会一并出现在结果 JSON 里。若 `worktree add` 失败，本次分支做**尽力回滚**；回滚删除失败（如 stale ref lock）时不静默吞掉，抛出的错误显式报告 `orphan branch remains: worktree-<name>` 并给出手动 cleanup 命令 `git -C <root> branch -D worktree-<name>`。

3. **切换工作目录（关键，agent 必须手动执行）**：脚本无法改变父 agent 进程的 cwd。成功时 stdout 最后一行是稳定 JSON（`ensure_ascii=False`），例如 `{"worktree_path": "...", "branch": "worktree-...", "base_ref": "..."}`。agent 必须解析该 JSON、记录 `worktree_path` 绝对路径，并把此后**所有** `Read`/`Edit`/`Write`/`Bash` 及 agent 工作目录都切到该路径；shell 命令必要时用 `git -C "<worktree_path>"` 或显式设置 cwd。**禁止**继续在启动 checkout 上操作。
4. 若当前会话仍在另一个任务的 worktree 中，不得把它复用于新任务，也不得主动退出或删除它。说明当前状态，并请用户明确选择保留退出后创建新 worktree，或在启动 checkout 中开启新会话；获得选择后再继续。
5. 若 `create_worktree.py` 非 0 退出，立即停止写入并如实报告其输出。**初始化失败时脚本会保留已创建的 worktree 和分支**（不自动 force remove，避免数据丢失），并给出安全 cleanup 指引；除非用户明确要求，不要自动删除。

### 内部/诊断：单独跑 initializer（正常流程不需要）

`scripts/initialize_worktree.py` 是被 creator 内部调用的初始化器，也可单独运行做诊断：

```bash
python ".claude/skills/worktree-development/scripts/initialize_worktree.py"
```

   该脚本是初始化 gate + 数据引导，仅用 Python 标准库、不依赖任何项目 package、不联网：先验证当前 cwd 是 linked git worktree、工作区初始干净，并输出 `git worktree list`、`git status --short --branch`、`git rev-parse --show-toplevel` 作为证据；gate 通过后，从**同一 Git 仓库的 primary（main）checkout**（经 `git worktree list --porcelain` + 共享 git common-dir 定位，UTF-8 解码，支持空格/中文路径）读取固定的 zhaochaoyi SQLite 源库 `<primary_root>/data/<UUID>/coros.db`，用 stdlib `sqlite3.Connection.backup()`（source 只读 `mode=ro`，不 checkpoint、不改变 source 的逻辑内容（main + WAL）、不删除 source 的 main/wal；SQLite 只读 WAL reader 可能创建/更新 transient `-shm` 用于 reader 协调）在目标同目录的独占临时子目录里生成一份 WAL 一致快照，经 magic + `PRAGMA integrity_check`（结果须严格为 `ok`）校验、fsync 后 `os.replace` 原子刷新到当前 worktree 的 canonical 目录 `data/<UUID>/coros.db`。source-of-truth 是 primary checkout 的 `data/.slug_aliases.json`（zhaochaoyi 须映射固定 UUID），不以目标 branch 的 alias 做安全授权。若目标存在 `coros.db-wal` / `coros.db-shm` / `coros.db-journal` 任一 sidecar 或 dangling symlink/junction（backup 前及 replace 前各查一次），脚本 fail closed：不删除、不替换、不触碰旧 DB。**写入前还会用 hardened git 校验 canonical target 必须 untracked 且被 git ignore**：`git ls-files --error-unmatch` 命中（tracked）即拒绝——避免把 PII 变成 tracked modification；`git check-ignore -q` 不命中（缺 `*.db` 等 ignore 规则）也拒绝；只有 untracked + ignored 才允许快照。脚本绝不 import 目标 worktree 的 `src`、不执行目标 branch 的任何代码、不复制 config/auth/secrets、不处理其他用户。gate 应在 ignored DB 写入前通过。

6. initializer 只有以 0 退出后才可开始写入。它 fail closed：gate 失败（primary checkout、dirty 工作区、非 git 目录）、无法定位 primary checkout、primary alias 不匹配、source DB 缺失/0 字节/symlink、路径逃逸/symlink/junction、目标 WAL/SHM/journal sidecar 或 dangling link 存在、或快照/校验（含 `integrity_check` 非 `ok`）失败都会非零退出并停止；此时立即停止写入，如实报告脚本输出（脚本对 sqlite/os 异常仅报类型+阶段，不输出敏感 message），不要清理或覆盖已有内容。既有 `coros.db` 仅在快照校验成功后才被原子替换，失败时保留原文件；临时快照子目录在任何异常下都被清理，不留 temp 的 wal/shm。

## 在 worktree 中开发

- 所有代码探索、设计、实现、依赖安装、数据生成、测试、构建、浏览器 smoke、验证和 review 都从新 worktree 路径执行。
- 所有 `Read`、`Write`、`Edit`、`Bash` 和 agent 工作目录必须指向该 worktree；不要再引用启动 checkout 的绝对路径。
- 不要把启动 checkout 中未提交或未跟踪的文件自动复制进来。若任务确实依赖它们，先说明缺失内容并取得明确授权。
- Reviewer/verifier 必须审查当前任务 worktree 的 diff；不要让 approval pass 落到启动 checkout 或另一条隔离分支。
- 遵守项目 `CLAUDE.md` 的 TDD、topic-specific docs、验证和 review gate。
- 仅在用户明确要求时 commit、push 或创建 PR；这些操作也必须在当前任务 worktree 中完成。

## 收尾

1. 在当前 worktree 中运行适用测试和项目要求的真实验证。
2. 使用独立 reviewer/verifier 审查当前 worktree 的最终 diff，并处理阻断问题。
3. 运行 `git status --short --branch`，如实报告剩余改动、测试结果、worktree 路径和分支。
4. 默认保持 worktree 可用。只有用户明确要求离开或删除时才用 `git -C "<primary_root>" worktree remove "<worktree_path>"`（必要时加 `git branch -D worktree-<name>`）；删除前必须确认不会丢失改动或未合并提交。

## 例外

以下情况无需创建 worktree：

- 纯解释、问答或只读状态查询，且不会产生项目文件或执行有副作用的命令。
- 当前会话已经位于专门为本任务新建的 worktree。
- 用户明确指定使用某个现有 worktree。

无法确定任务是否会写入时，按写入型任务处理并创建新 worktree。
