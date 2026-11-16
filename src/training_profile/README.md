# @stride/training-profile

独立 TypeScript POC 包：只读资料快照 → 固定计算＋DeepSeek Flash 专项子Agent → master复核 → 私人本地文件。

按十个维度归类，每条信息分别标记性质、来源、形成方式和生命周期，并逐项复核旧认识。输出JSON／Markdown、维度与生命周期视图、来源及计算记录。

从仓库根目录构建和校验：

```sh
pnpm install --frozen-lockfile
pnpm --filter @stride/training-profile... build
pnpm --filter @stride/training-profile test
```

当前编排见 [十维POC](../../docs/spike/training-profile/TEN-DIMENSION-POC.md)，CLI运行与输入要求见 [运行说明](../../docs/spike/training-profile/README.md)。该包没有生产入口，不接数据库或训练计划；内容质量仍需审阅。
