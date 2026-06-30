"""Back-compat shim: the coach persistence layer moved to
``stride_storage.coach_persistence``.

Submodule shims here re-export the relocated implementation so existing
``stride_server.coach_adapters.persistence.<mod>`` imports keep working. The
server-coupled ``*_from_env`` factories (which load ServerConfig) live in the
shims, not in stride_storage. To be removed in the Phase-7 cleanup.
"""
