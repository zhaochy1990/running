"""Time-series helpers shared between sync and read APIs.

Equal-bucket mean downsampling that preserves ``None`` semantics — used by
the mobile activity-detail endpoint to keep payloads small while not
distorting gaps (GPS dropouts, sensor disconnects).
"""

from __future__ import annotations


def downsample_series(
    points: list[float | None],
    target_count: int,
) -> list[float | None]:
    """Downsample ``points`` to (at most) ``target_count`` buckets.

    Algorithm:
      - If ``len(points) <= target_count`` the input is returned unchanged.
      - Otherwise the input is partitioned into ``target_count`` near-equal
        buckets; each bucket's value is the arithmetic mean of its non-``None``
        members. A bucket where every member is ``None`` collapses to ``None``.

    ``target_count`` must be >= 1.
    """
    if target_count < 1:
        raise ValueError("target_count must be >= 1")
    n = len(points)
    if n == 0:
        return []
    if n <= target_count:
        return list(points)

    out: list[float | None] = []
    for i in range(target_count):
        start = (i * n) // target_count
        end = ((i + 1) * n) // target_count
        if end <= start:
            end = start + 1
        bucket = points[start:end]
        vals = [v for v in bucket if v is not None]
        if not vals:
            out.append(None)
        else:
            out.append(sum(vals) / len(vals))
    return out
