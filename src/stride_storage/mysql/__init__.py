"""Dormant SQLAlchemy/MySQL backend foundation.

Nothing in the production storage path imports this package yet. Callers must
explicitly construct an engine from a resolved ``DatabaseStorageConfig``.
"""
