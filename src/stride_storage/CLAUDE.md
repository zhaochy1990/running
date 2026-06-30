# CLAUDE.md — `stride_storage`

在本包内写 / 改代码前必读。这是 STRIDE 的统一数据访问层；总览见同目录 `README.md`，全局规则见仓库根 `CLAUDE.md` 的 *Storage scope rule* 段。

## HARD 规则

### 1. 三层 import 纪律（`.importlinter` 强制）

| Tier | 子包 | 允许依赖 |
|------|------|----------|
| A | `interfaces/` | 仅 `typing` / `dataclasses` / `stride_core` 纯域类型。**禁** `sqlite3` / `azure` / 任何 I/O |
| B | `sqlite/` · `content/` | `sqlite3` + `stride_core` 纯域 + Tier A。content 的 blob 后端**注入**，不直接 import azure |
| C | `azure/` · `keyvault/` · `coach_persistence/` | Azure SDK（lazy）+ Tier A/B + `stride_core` |

改完跑 `PYTHONPATH=src lint-imports`，**5 contract 必须全 KEPT**。相关契约：
- **Contract 3 / 4**：纯公式层 `training_load.{core,calibration,types}`、`running_calibration.{core,…}` 禁止 import `stride_storage.{sqlite,azure,content,keyvault,coach_persistence}`。
- **Contract 5**：`coach` 禁止 import `stride_storage.{sqlite,azure,content,keyvault,coach_persistence}`（只可 `interfaces`）。

### 2. Azure-free 不变量（HARD）

所有 `azure.*` import **必须在函数体内**（lazy），绝不在模块顶层。判据：`import stride_storage` / `.interfaces` / `.sqlite` / `.content` 在没装 `azure-*` 的环境下也成功。`__init__.py` 绝不 eager import azure。回归测试 `tests/stride_storage/test_azure_free_imports.py` 守这条 —— 加了顶层 azure import 会让它失败。

### 3. config 加载留 server 侧（HARD —— 防成环）

本包**绝不** import `stride_server`。工厂只接收**已解析**的 config dataclass：

```python
def backend_from_config(config: LikesStorageConfig) -> LikesBackend: ...
```

`ServerConfig` 的 TOML/env/Key Vault 合并与缓存住在 `stride_server.config`；server facade（如 `stride_server/likes_store.py`）负责 `load_server_config().storage.likes → backend_from_config(...)` + 缓存。**不要**在本包里 `from stride_server.config import load_server_config`。

### 4. 复用共享原语，不要重造

| 要做的 | 用这个 | 别这么做 |
|--------|--------|----------|
| 拿 Azure 凭据 | `azure/credentials.py::get_credential()` | `DefaultAzureCredential()` |
| Azure Table 客户端 | `azure/table_backend.py::AzureTableConnection`（lazy/线程安全/create-table-once）| 自己写 `_get_client` |
| Azure Blob 容器客户端 | `azure/blob_backend.py::get_container_client()` | `BlobServiceClient(...)` |
| Key Vault 客户端 | `keyvault/secret_client.py::get_secret_client()` | `SecretClient(...)` |
| dev-file / prod-azure 选择 | `azure/backend_select.py::choose_backend(url, azure_factory=…, file_factory=…)` | `if account_url: ... else: ...` |

`AzureTableConnection` 的 `create_table` 是 **best-effort**（catch `ResourceExistsError`，其余 log+继续）—— 故意统一，别在调用侧重写更严的错误处理。

### 5. `USER_DATA_DIR` 路径常量例外（HARD —— monkeypatch seam）

`USER_DATA_DIR` / `DB_PATH` / `PROJECT_ROOT` / `_parse_week_folder_dates` **不在本包**，住在 `stride_core.db`（纯 pathlib/regex）。原因：它们是 213 处引用 + 60 处测试 `monkeypatch.setattr(stride_core.db, "USER_DATA_DIR", tmp)` 的 canonical 目标。

`sqlite/database.py` 经 **lazy `_paths()`**（函数内 `import stride_core.db`）在调用时读回 —— 这样 monkeypatch 可见、且无 import 环（`stride_core.db` 不 import 本包）。**不要**把这些常量搬进本包，也不要在 `database.py` 模块顶层 `import stride_core.db`（会成 import-time 环）。

### 6. content store 是 blob 注入式

`content/store.py` 是**纯函数**：每个函数收 `config: ContentStorageConfig` + 一个 `container_client` 工厂回调，本包内**不直接** import azure blob。真实 blob 工厂 `azure/blob_backend.py::get_container_client` 由 server facade（`stride_server/content_store.py`）注入。这保住 content tier 纯净 + 保住测试的 `monkeypatch.setattr(content_store, "_container_client", fake)` seam。

## 加一个新 store 的标准套路（以 likes 为样板）

1. **`interfaces/<name>.py`**：result dataclass（如 `LikeEntity`）+ `<Name>Backend` Protocol。纯 typing。
2. **`interfaces/config.py`**：加 `<Name>StorageConfig`（frozen dataclass）。
3. **`azure/<name>_backend.py`**：`File<Name>Backend`（JSON，dev）+ `AzureTable<Name>Backend`（用 `AzureTableConnection`）+ `backend_from_config(config) -> <Name>Backend`（用 `choose_backend`）。azure import 全 lazy。
4. **server 侧** `stride_server/<name>_store.py`：config 解析 + `@lru_cache` backend + 公共 API；re-export 搬来的符号。
5. **`coach` 用到**：走 `coach_adapters` DI，coach 只见 `interfaces.<name>` 的 Protocol。
6. 跑 `lint-imports`（5/5 KEPT）+ `pytest`。

## 测试约定

- 文件后端读 `core_db.USER_DATA_DIR` **在调用时**（非 import 时），保住测试 monkeypatch。
- 注入 fake Database 的测试 patch `stride_storage.sqlite.database.Database`（类在这）。
- 加新 Azure 后端时，azure-free 测试 + lint Contract 5 会自动守住 coach 隔离。
