# Master Plan 设计稿

本目录存放赛季训练计划场景的 Stitch HTML 导出快照。这里的页面只用于本地审阅；正式设计源仍是 Stitch 项目 `STRIDE · Web`。

- 设计系统: `STRIDE Endurance Lab`
- 范围: Web Desktop
- 格式: HTML-only

按用户故事拆分为两个子目录：

## [new_user/](./new_user/) — 新用户创建赛季训练计划

新用户从空白创建计划的完整闭环：信息收集 → Coach 追问 → 生成中 → 待查看 → 审阅 → 已启用首页（6 页）。详见 [new_user/README.md](./new_user/README.md)。

## [existing_user/](./existing_user/) — 存量用户修改赛季训练计划

存量用户调整计划的主线（当前计划 → Coach 追问 → 生成中 → 调整后计划审阅）与边界状态（更新中、生成失败、无有效变化、流程恢复），共 8 页。详见 [existing_user/README.md](./existing_user/README.md)。
