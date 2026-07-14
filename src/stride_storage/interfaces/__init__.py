"""Tier A — pure storage interfaces: Protocols + frozen config dataclasses.

No ``sqlite3`` or ``azure`` import lives below this package. Safe for any
consumer, including the pure ``coach`` runtime.
"""

from stride_storage.interfaces.config import (
    AzureKeyVaultConfig,
    CoachPersistenceConfig,
    ConfigError,
    ContentStorageConfig,
    DatabaseStorageConfig,
    JPushConfig,
    LikesStorageConfig,
    MasterPlanStorageConfig,
    NotificationConfig,
    NotificationStorageConfig,
    QueueStorageConfig,
    StorageConfig,
    validate_optional_url,
    validate_positive,
    validate_required_when,
)
from stride_storage.interfaces.jobs import (
    GLOBAL_PARTITION,
    JobQueue,
    JobRecord,
    JobStatus,
    JobStore,
    PipelineRunRecord,
    PipelineRunStore,
    QueueMessage,
)
from stride_storage.interfaces.likes import LikeEntity, LikesBackend
from stride_storage.interfaces.rows import StorageRow

__all__ = [
    "AzureKeyVaultConfig",
    "CoachPersistenceConfig",
    "ConfigError",
    "ContentStorageConfig",
    "DatabaseStorageConfig",
    "GLOBAL_PARTITION",
    "JobQueue",
    "JobRecord",
    "JobStatus",
    "JobStore",
    "JPushConfig",
    "LikeEntity",
    "LikesBackend",
    "LikesStorageConfig",
    "MasterPlanStorageConfig",
    "NotificationConfig",
    "NotificationStorageConfig",
    "PipelineRunRecord",
    "PipelineRunStore",
    "QueueMessage",
    "QueueStorageConfig",
    "StorageConfig",
    "StorageRow",
    "validate_optional_url",
    "validate_positive",
    "validate_required_when",
]
