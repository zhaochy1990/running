# stride_storage

STRIDE 的**统一数据访问层**。API Server (`stride_server`) 与 Coach Agent (`coach`) 共享的唯一持久化包：SQLite（手表同步运动数据）、Azure Table / Blob（社交信号、计划、通知、coach checkpoints）、markdown/JSON content store、Azure Key Vault secret 读写。

> 提取自原先横跨 `stride_core`（SQLite）+ `stride_server`（Azure/文件/KV）的存储代码，消除了 8 份重复的 dev/prod 后端选择 + 8 个独立 `DefaultAzureCredential()`。

## 三层结构（`.importlinter` 强制）

| Tier | 子包 | 装什么 | 谁能 import |
|------|------|--------|-------------|
| **A** | `interfaces/` | 纯 Protocol + frozen config dataclass（**不** import `sqlite3`/`azure`）| 任何包，含纯运行时 `coach` |
| **B** | `sqlite/` · `content/` | `Database`、state stores、calibration connector、content 原语；依赖 `sqlite3` + `stride_core` 纯域 | `stride_server` 等；**`coach` 不可** |
| **C** | `azure/` · `keyvault/` · `coach_persistence/` | 仅 Azure SDK（Table/Blob/Key Vault）、LangGraph coach 持久化 | `stride_server`；**`coach` 永不** |

**Azure-free 不变量**：所有 `azure.*` import 都在函数体内（lazy）。`import stride_storage`、`import stride_storage.interfaces`、`import stride_storage.sqlite` 全程不拉 Azure SDK —— 离线/测试无需装 `azure-*`。回归测试见 `tests/stride_storage/test_azure_free_imports.py`。

## 目录

```
stride_storage/
  __init__.py              # 只 re-export interfaces；绝不 eager import azure
  interfaces/              # ── Tier A ──
    config.py              #   存储 config dataclass（StorageConfig / *StorageConfig / CoachPersistenceConfig …）+ 校验
    likes.py               #   LikeEntity + LikesBackend
    master_plan.py         #   MasterPlanStore
    notifications.py       #   DeviceEntity + NotificationsBackend
    athlete_memory.py      #   AthleteMemoryBackend
  sqlite/                  # ── Tier B ──
    database.py            #   Database 类（schema / migration / upsert / query；手表同步运动数据）
    state_stores.py        #   PlanStateStore / CommentaryStore / InBodyStore Protocol + Sqlite 实现
    calibration_connector.py  #   SQLiteRunningCalibrationRepository
  content/                 # ── Tier B（blob 后端注入）──
    store.py               #   plan.md / feedback.md / plan.json 等 read/write/list（纯函数，注入 container_client）
  azure/                   # ── Tier C ──
    credentials.py         #   get_credential() —— 进程唯一 DefaultAzureCredential（共享）
    table_backend.py       #   AzureTableConnection —— lazy/线程安全/create-table-once
    blob_backend.py        #   get_container_client()
    backend_select.py      #   choose_backend() —— 统一 "account_url 有则 azure 否则 file"
    likes_backend.py master_plan_backend.py athlete_memory_backend.py notifications_backend.py
  keyvault/                # ── Tier C ──
    secret_client.py       #   get_secret_client() —— 共享 SecretClient
  coach_persistence/       # ── Tier C（langgraph + azure）──
    store.py file_backend.py azure_backend.py envelope.py
    checkpointer.py jobs_store.py weekly_version_store.py
```

## 用法

**读 config dataclass / Protocol（任何包，含 coach）：**

```python
from stride_storage.interfaces import StorageConfig, LikesStorageConfig, LikeEntity
```

**建 SQLite Database（server / sync / CLI）：**

```python
from stride_storage.sqlite.database import Database

db = Database(user=user_id)        # data/{user_id}/coros.db
db = Database(db_path=":memory:")  # 显式路径
```

**用某个 store 后端（server 侧）—— config 由 server 解析后注入工厂：**

```python
from stride_server.config import load_server_config
from stride_storage.azure.likes_backend import backend_from_config

backend = backend_from_config(load_server_config().storage.likes)
backend.put(LikeEntity(...))       # account_url 有 → Azure Table；否则 JSON file
```

## 核心约定

- **config 加载留 server 侧**：本包的 `*_from_config()` 工厂只接收**已解析**的 config dataclass；`ServerConfig`（TOML/env/Key Vault 合并、缓存）住在 `stride_server.config`。本包**绝不** import `stride_server`（否则成环）。
- **共享原语**：建 Azure 客户端一律走 `azure/credentials.py::get_credential`、`azure/table_backend.py::AzureTableConnection`、`azure/blob_backend.py::get_container_client`、`keyvault/secret_client.py::get_secret_client`；后端选择走 `azure/backend_select.py::choose_backend`。不要再 new `DefaultAzureCredential()` 或重写 dev/prod 分支。
- **路径常量例外**：`USER_DATA_DIR` / `DB_PATH` / `_parse_week_folder_dates` **不在本包**，住在 `stride_core.db`（纯 pathlib/regex，是 caller + 测试的 canonical monkeypatch 目标）。`sqlite/database.py` 经 lazy `_paths()` 在调用时读回，故 monkeypatch 可见且无 import 环。
- **`coach` 经 DI 拿数据**：`coach` core 只可 import `stride_storage.interfaces`；具体 store 由 `stride_server.coach_adapters` 构造后注入。`coach` 禁止 import 实现层（Contract 5）。

加新 store / 改实现前请读同目录 `CLAUDE.md`。
