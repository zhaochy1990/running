# Working Model — Local Authoring + Cloud Draft-Writer

**何时读**：要更新 `activity_commentary`、产出 weekly plan、或推 markdown 到 prod 时必读。

## 分工

- **Local machine** 是 **author** 环境。LLM 工具（Claude Code）在这里跑，读 local state（SQLite + `data/` 下 markdown），产出权威内容：weekly `plan.md`、`feedback.md`、refined `activity_commentary` DB 行，以及临时分析。
- **Azure Container App (`stride-app`)** 是 **reader** 环境，**同时也是 default draft-writer**。它服务 dashboard UI 和 read API，数据来自：
  - Markdown 文件经 `sync-data.yml` GitHub Action 同步（push 到 master → `az storage file upload-batch` 到 `authstorage2026/stride-data`）。
  - SQLite 数据（activities、health）两端各自独立从 COROS 同步。
  - 不是 COROS 源、只在本地的 DB 行（如 Claude Code refined `activity_commentary`），必须经 authenticated API 推过去 —— 它们不走 markdown 同步路径。
  - **Azure OpenAI (GPT-4.1)** 在 server 端 MI-authenticated 自动给每个新同步的活动生成 commentary **草稿**，戳 `generated_by='gpt-4.1'`。

## Commentary authorship rules

- 每个 `activity_commentary` 行带 `generated_by`（模型 ID：`gpt-4.1`、`claude-opus-4-7` 等）和 `generated_at`。
- `sync` 时的自动生成 **永远不覆盖已有行**，只填空。
- 用 Claude Code refinement 覆盖 AOAI 草稿：本地写入行（`generated_by=<your model>`），然后 `coros-sync commentary push <id> --generated-by <your model>`。
- 强制刷新 AOAI 草稿（覆盖现有）：`POST /api/{user}/activities/{id}/commentary/regenerate`，或活动详情页"重新生成"按钮。
- AOAI 由 `AOAI_COMMENTARY_ENABLED=true` + `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_DEPLOYMENT` env 控制。Auth：设 `AZURE_OPENAI_API_KEY` 走 key auth，不设走 MI + `Cognitive Services OpenAI User` RBAC。任一必需 env 缺失则 sync 静默跳过 AOAI。

## Canonical daily loop

```bash
# 1. Sync COROS 数据到本地 DB。Prod 端 AOAI 给每个新活动自动写 gpt-4.1
#    草稿 commentary（server 在自己的 sync 路径里做，本地只看到 activity 行）。
PYTHONIOENCODING=utf-8 python -m coros_sync -P zhaochaoyi sync

# 2. [Claude does its thing] —— refine AOAI 草稿、写 plan/feedback、用本地数据
#    产出更深的 commentary。本地 DB 行必须带正确的 generated_by:
python -c "
from stride_core.db import Database
db = Database(user='zhaochaoyi')
db.upsert_activity_commentary('<label_id>', '<text>', generated_by='claude-opus-4-7')
"

# 3a. Commentary → STRIDE prod，authenticated POST。必须传 --generated-by 否则
#     prod 端 generated_by 保持 NULL，UI badge 空白 / 再 sync 时 AOAI 可能覆盖。
coros-sync -P zhaochaoyi commentary push <label_id> --generated-by claude-opus-4-7

# 3b. plan.md / feedback.md / TRAINING_PLAN.md / status.md → STRIDE prod via git
git add data/<user-uuid>/logs/<week>/plan.md
git commit -m "docs: update week plan"
git push origin master   # sync-data.yml 把 markdown 推到 Azure Files
```

## When something only works locally but not in prod

最大概率：内容是 DB 行，没传播。先查 `activity_commentary`。`plan.md` / `feedback.md` 应该总是经 git push + `sync-data.yml` 传播；如果没有，看 workflow run。
