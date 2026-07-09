# STRIDE Stitch Web 设计稿索引

本目录存放 STRIDE Web 端 Stitch 设计稿导出快照。Stitch 是正式设计源，本地文件只用于审阅、故事排序和归档索引。

- Stitch 项目: `STRIDE · Web`
- 设计系统: `STRIDE Endurance Lab`
- 范围: Web Desktop
- 格式: HTML-only，本地不再保留截图
- 映射: [manifest.json](./manifest.json) 记录 HTML 快照对应的 Stitch screen id 与归档 HTML

## 场景目录

### Master Plan / 赛季训练计划

赛季训练计划相关设计稿已集中到 [master_plan/](./master_plan/)。包含新用户生成赛季训练计划、存量用户修改赛季训练计划、计划更新中的边界状态。

- 故事索引: [master_plan/README.md](./master_plan/README.md)
- 页面数量: 14 个 HTML

### QA / 日常问答

日常 Coach 问答相关设计稿已集中到 [qa/](./qa/)。包含当前 markdown 回复渲染，以及理想 structured JSON / stride-card 输出下的指标摘要、单次训练复盘、疲劳分流和疼痛分流。QA 只使用两栏布局；计划调整入口可以作为聊天内联 CTA 出现，但计划更新流程归属 Master Plan 或 Weekly Plan 场景。

- 故事索引: [qa/README.md](./qa/README.md)
- 页面数量: 5 个 HTML

### Weekly Plan / 本周课表

本周课表相关设计稿已集中到 [weekly_plan/](./weekly_plan/)。包含本周课表首页、调整本周、生成中、本周变化审阅、赛季训练计划影响提示和启用成功状态。

- 故事索引: [weekly_plan/README.md](./weekly_plan/README.md)
- 页面数量: 6 个 HTML

## 维护规则

- `frontend/design/` 下只保留 HTML 设计快照和索引文件。
- 新增或移动 HTML 后，需要同步更新本 README、对应场景 README 和 [manifest.json](./manifest.json)。
- 不在本目录提交 PNG 截图；需要视觉检查时，可以临时生成或使用 Stitch 内部预览。
- 本地 HTML 不是设计源，正式设计修改仍需先在 Stitch 中完成。
