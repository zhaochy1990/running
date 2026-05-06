/// Cache TTL policy — cached data older than this is considered stale and
/// triggers a background refresh on next read.
const Duration kCacheTtl = Duration(minutes: 5);

/// True if [cachedAt] is older than [ttl].
bool isStale(DateTime cachedAt, [Duration ttl = kCacheTtl]) {
  return DateTime.now().difference(cachedAt) > ttl;
}
