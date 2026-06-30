"""Tier C — Azure-backed storage implementations.

Everything under this subpackage may import the Azure SDK. ``coach`` must
never import ``stride_storage.azure`` (enforced by ``.importlinter`` Contract
5). Azure imports are kept *inside functions* so that merely importing a
module here stays azure-free — the file/dev backends and unit tests work
without ``azure-*`` installed.
"""
