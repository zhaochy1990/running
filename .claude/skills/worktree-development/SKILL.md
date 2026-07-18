---
name: worktree-development
description: 必须在 running 项目中任何可能修改仓库内容的开发任务开始前使用，包括 feature、bug fix、refactor、测试、文档、配置、设计和生成文件。先为当前任务创建并切换到全新的 Git worktree，再在其中完成探索、实现、测试、验证、review、commit 和 push，避免污染启动 checkout。
---

# Worktree-first development

## 硬性不变量

每个新的写入型任务必须使用一个专属的新 worktree。启动 checkout 只用于开启会话和纯只读操作，不得在其中修改项目文件。

同一个任务的连续对话复用该任务的 worktree；新任务不得复用旧任务的 worktree。

## 开始任务

1. 在读取任务相关实现文件、安装依赖或修改任何项目文件前，先判断当前任务是否已有本会话为它创建的 worktree。
2. 若当前任务尚无 worktree，调用 `EnterWorktree`，使用根据任务目的生成的 3–5 词 kebab-case 名称，例如 `fix-training-load-dates`。
3. 使用 `EnterWorktree`，不要用原始 `git worktree add` 代替；前者会创建分支并把当前 Claude Code 会话切换到新 worktree。不要在 frontmatter 添加 `context: fork` 来替代它：`context: fork` 只创建隔离的 subagent 对话上下文，不创建 Git worktree，也不会切换主会话目录。
4. 若当前会话仍在另一个任务的 worktree 中，不得把它复用于新任务，也不得主动退出或删除它。说明当前状态，并请用户明确选择保留退出后创建新 worktree，或在启动 checkout 中开启新会话；获得选择后再继续。
5. 切换后立即运行以下只读检查：

```bash
git worktree list
git status --short --branch
git rev-parse --show-toplevel
```

6. 确认返回路径是新 worktree，且初始工作区干净。若状态异常，停止写入并报告事实，不要清理或覆盖已有内容。

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
4. 默认保持 worktree 可用。只有用户明确要求离开或删除时才调用 `ExitWorktree`；删除前必须确认不会丢失改动或未合并提交。

## 例外

以下情况无需创建 worktree：

- 纯解释、问答或只读状态查询，且不会产生项目文件或执行有副作用的命令。
- 当前会话已经位于专门为本任务新建的 worktree。
- 用户明确指定使用某个现有 worktree。

无法确定任务是否会写入时，按写入型任务处理并创建新 worktree。
