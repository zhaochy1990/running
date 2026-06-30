"""Tier A — pure storage interfaces: Protocols + frozen config dataclasses.

No ``sqlite3`` or ``azure`` import lives below this package. Safe for any
consumer, including the pure ``coach`` runtime.
"""

from stride_storage.interfaces.config import (
    AzureKeyVaultConfig,
    CoachPersistenceConfig,
    ConfigError,
    ContentStorageConfig,
    JPushConfig,
    LikesStorageConfig,
    MasterPlanStorageConfig,
    NotificationConfig,
    NotificationStorageConfig,
    StorageConfig,
    validate_optional_url,
    validate_positive,
    validate_required_when,
)
from stride_storage.interfaces.likes import LikeEntity, LikesBackend

__all__ = [
    "AzureKeyVaultConfig",
    "CoachPersistenceConfig",
    "ConfigError",
    "ContentStorageConfig",
    "JPushConfig",
    "LikeEntity",
    "LikesBackend",
    "LikesStorageConfig",
    "MasterPlanStorageConfig",
    "NotificationConfig",
    "NotificationStorageConfig",
    "StorageConfig",
    "validate_optional_url",
    "validate_positive",
    "validate_required_when",
]
