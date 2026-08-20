# STRIDE Stitch Mobile Design

这里是 STRIDE 手机端的 Stitch SDK 工作区。Stitch 项目和 screen ID 是设计源；本目录中的 brief、manifest 与 HTML 是生成输入和本地审阅快照，不替代 Stitch 中的设计。

## 目录

```text
src/stitch_design/
├── cli.ts                 # Stitch SDK CLI
├── stitch.config.json     # 项目 ID、设计系统 ID 与路径配置
├── design-system.json     # 可提交给 Stitch 的结构化设计系统
├── prompts/
│   └── foundation.md      # 每次生成、编辑和 variants 都会注入的基线
├── briefs/
│   └── _template.md       # 单屏需求模板
└── artifacts/
    └── manifest.json      # screen ID 与本地快照索引
```

视觉基线继承 `mobile/DESIGN.md`，STRIDE 品牌差异继承 `mobile/STRIDE_OVERRIDES.md`。当前生成目标固定为 `MOBILE`，默认使用简体中文界面、Android 优先、390 px 逻辑宽度。

## 初始化

要求 Node.js 20.12 或更高版本。

```bash
cd src/stitch_design
npm install
npm run stitch -- doctor
```

认证支持以下任一方式：

```bash
STITCH_API_KEY=... npm run stitch -- projects
```

或同时设置 `STITCH_ACCESS_TOKEN` 与 `GOOGLE_CLOUD_PROJECT`。也可以将变量放在本目录不入库的 `.env` 中。

## 首次建立 Stitch 项目

```bash
npm run stitch -- create-project "STRIDE · Mobile"
npm run stitch -- create-design-system
```

命令会把返回的 project ID 和 design system ID 写入 `stitch.config.json`。如果已有手机端 Stitch 项目，先运行 `projects`，再手动把正确的 ID 写入配置；不要重复创建同名项目。

修改本地设计 token 或 foundation 后，同步更新已有设计系统：

```bash
npm run stitch -- update-design-system
```

## 共同设计流程

1. 先运行 `screens` 检查已有页面，避免重复生成。
2. 根据 `briefs/_template.md` 在 `briefs/` 建立单屏 brief。
3. 首次设计使用 `generate`；针对现有 screen 的调整使用 `edit`。
4. 需要比较方向时使用 `variants`，不要为细微文案差异制造多个 screen。
5. 在浏览器中审阅 `artifacts/` 中的 HTML，以 Stitch screen ID 追踪正式版本。

```bash
npm run stitch -- screens
npm run stitch -- generate briefs/home.md --slug home
npm run stitch -- edit <screen-id> briefs/home-refine.md --slug home-refine
npm run stitch -- variants <screen-id> briefs/home-variants.md --count 3 --range EXPLORE
npm run stitch -- export <screen-id> --slug home
npm run stitch -- publish artifacts/<screen-id>_home.html --title "跑者主页 · 本周课表进行中"
```

`generate`、`edit` 和 `variants` 默认只下载 HTML，并更新 `artifacts/manifest.json`。不下载或归档 PNG、JPEG、WebP。只想在 Stitch 中生成时可传 `--no-export`。

`artifacts/` 只提交 manifest 中标记为 `approved` 的 canonical HTML。候选稿、失败稿和重复 verify 文件在提交前删除。

如果 Stitch 生成结果可通过 ID 获取、但尚未出现在项目画布，使用 `publish` 将最终 HTML 创建为带 screen instance 的正式项目页面。

## 校验

```bash
npm run check
npm run stitch -- help
```

SDK 文档：<https://stitch.withgoogle.com/docs/sdk/tutorial/>
