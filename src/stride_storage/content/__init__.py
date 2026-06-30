"""Tier B — content storage (markdown / JSON authoring artifacts).

Blob-or-filesystem read/write for ``data/{user}/logs/...`` artifacts. The
functions are pure: they take a resolved ``ContentStorageConfig`` and an
injected ``container_client`` factory, so this package never imports the Azure
SDK directly (the blob backend is supplied by
``stride_storage.azure.blob_backend``). Config *loading* stays in
``stride_server.content_store``.
"""
