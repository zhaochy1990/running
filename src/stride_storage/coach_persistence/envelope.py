"""Serialization envelope for coach checkpoint state — see plan §4.2.

Every checkpoint state dict is round-tripped through this single envelope so
file and Azure backends produce bit-identical bytes for the same input:

    state_dict --json.dumps(sort_keys, separators)--> raw_bytes
              ----------------- gzip ---------------> compressed_bytes
              -------------- sha256 -----------------> sha256_hexdigest

The reverse path verifies the sha256 before parsing the JSON so a corrupted
blob raises ``CheckpointIntegrityError`` instead of silently producing wrong
state.
"""

from __future__ import annotations

import gzip
import hashlib
import json
from dataclasses import dataclass
from typing import Any


# Canonical JSON formatting: sort keys + tight separators → deterministic bytes
# for the same logical dict, so two backends serialising the same state
# produce byte-equal blobs (the dual-backend acceptance criterion).
_JSON_KWARGS: dict[str, Any] = {
    "ensure_ascii": False,
    "sort_keys": True,
    "separators": (",", ":"),
    "default": str,
}


class CheckpointIntegrityError(RuntimeError):
    """Raised when a stored checkpoint blob fails sha256 verification."""


@dataclass(frozen=True)
class EncodedCheckpoint:
    """Result of encoding a state dict for storage."""

    compressed_bytes: bytes
    sha256_hexdigest: str
    uncompressed_bytes: int

    @property
    def size_bytes(self) -> int:
        return len(self.compressed_bytes)


def encode_state(state: dict[str, Any]) -> EncodedCheckpoint:
    """Serialise + gzip + hash a state dict."""
    raw = json.dumps(state, **_JSON_KWARGS).encode("utf-8")
    compressed = gzip.compress(raw, compresslevel=6)
    digest = hashlib.sha256(compressed).hexdigest()
    return EncodedCheckpoint(
        compressed_bytes=compressed,
        sha256_hexdigest=digest,
        uncompressed_bytes=len(raw),
    )


def decode_state(blob_bytes: bytes, *, expected_sha256: str | None = None) -> dict[str, Any]:
    """Reverse of :func:`encode_state`. Raises ``CheckpointIntegrityError``
    when the blob doesn't match the expected sha256.
    """
    if expected_sha256 is not None:
        actual = hashlib.sha256(blob_bytes).hexdigest()
        if actual != expected_sha256:
            raise CheckpointIntegrityError(
                f"sha256 mismatch — blob is {actual} but Table says {expected_sha256}"
            )
    raw = gzip.decompress(blob_bytes)
    return json.loads(raw.decode("utf-8"))
