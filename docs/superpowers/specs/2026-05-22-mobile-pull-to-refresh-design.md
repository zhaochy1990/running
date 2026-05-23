# Mobile Pull-to-Refresh + Independent Sync Button — Design

**Date:** 2026-05-22
**Scope:** `mobile/lib/features_v2/` — all data-fetching screens
**Status:** approved, ready for implementation plan

## Goal

Today only D5 (`home_screen.dart`) has pull-to-refresh, and its pull
also triggers a server-side COROS sync (`api.triggerSync` + invalidate)
that can take 10–30 s. Every other v2 screen (D2a / D3 / D8 / E1 / G1 /
E2–E6) has no refresh affordance at all.

Add a fast, consistent pull-to-refresh to every data-fetching v2 screen
and move the slow COROS sync onto an explicit button so the two paths
don't compete on the same gesture.

## Decisions

1. **Scope:** all data-fetching v2 screens — D5, D2a, D3, D8, E1, G1,
   E2 (PMC), E3 (trends), E4 (ability radar), E5 (predictions),
   E6 (PB records).
2. **Pull semantics:** invalidate the local screen provider only.
   No `triggerSync`. Indicator stays spinning until
   `await ref.read(provider.future)` completes (~1 s for cached, longer
   if network is slow). Matches Material guideline "pull = re-fetch
   what's on screen".
3. **Sync semantics:** an explicit button on watch-data screens
   (D5, E1, E2–E6) calls `api.triggerSync` → invalidates the registered
   watch-data providers → shows a SnackBar on completion. The slow path
   is opt-in, never accidental.
4. **Abstraction:** new shared widget `StrideRefreshable<T>` wraps a
   scrollable, encapsulates the invalidate + await pattern, and applies
   the accent-coloured indicator.
5. **Sync controller:** new `SyncController` Notifier owns the single
   in-flight sync state. All sync buttons watch one provider so the
   spinner stays in sync across screens and a second tap during a
   running sync is a no-op.

## Architecture

```
mobile/lib/features_v2/_shared/
├── widgets/refreshable.dart    NEW — StrideRefreshable<T>
└── sync/sync_controller.dart   NEW — SyncController + SyncState + provider
```

### `StrideRefreshable<T>`

```dart
class StrideRefreshable<T> extends ConsumerWidget {
  const StrideRefreshable({
    super.key,
    required this.provider,
    required this.child,
  });

  /// The `.future` accessor on a FutureProvider (or family-invoked
  /// instance). `Refreshable<Future<T>>` covers both basic and
  /// `.autoDispose.family<T,P>(p)` cases.
  final Refreshable<Future<T>> provider;
  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return RefreshIndicator(
      color: StrideTokens.accent,
      onRefresh: () async {
        ref.invalidate(provider);
        try {
          await ref.read(provider);
        } catch (_) {
          // Swallow; the screen's own AsyncValue.when(error: ...)
          // path is what renders the error UI.
        }
      },
      child: child,
    );
  }
}
```

Callers pass `homeProvider.future` (or
`activityDetailProvider(id).future` for the family case) so the widget
gets both a `Refreshable` (for `invalidate`) and a `Future<T>` (for the
spinner to await).

### `SyncController`

```dart
class SyncState {
  const SyncState({this.syncing = false, this.lastSyncedAt, this.error});
  final bool syncing;
  final DateTime? lastSyncedAt;
  final Object? error;
  SyncState copyWith({...}) => ...;
}

class SyncController extends Notifier<SyncState> {
  @override
  SyncState build() => const SyncState();

  Future<void> triggerSync() async {
    if (state.syncing) return;
    final userId = ref.read(currentUserIdProvider);
    if (userId == null) return;

    state = state.copyWith(syncing: true, error: null);
    try {
      await ref.read(strideApiProvider).triggerSync(userId);
      ref.invalidate(homeProvider);
      ref.invalidate(healthOverviewProvider);
      ref.invalidate(pmcProvider);
      ref.invalidate(abilitySnapshotProvider);
      ref.invalidate(predictionsProvider);
      ref.invalidate(pbRecordsProvider);
      ref.invalidate(trendsProvider);
      state = state.copyWith(syncing: false, lastSyncedAt: DateTime.now());
    } catch (e) {
      state = state.copyWith(syncing: false, error: e);
      rethrow; // let the screen show a SnackBar with the message
    }
  }
}

final syncControllerProvider =
    NotifierProvider<SyncController, SyncState>(SyncController.new);
```

Notes:
- `NotifierProvider` (not autoDispose) so the controller is process-wide
  and `lastSyncedAt` survives screen navigation.
- The invalidation list is hard-coded; any new watch-data provider
  added in wave 2 must be appended here. A test verifies the list
  matches the set actually invalidated.
- The pmcProvider is a family — invalidating the family invalidates all
  param instances, which is what we want (e.g. user has switched
  between 30d / 90d / 180d ranges).

## Per-screen integration

| ID | File | Scrollable widget | Provider for refresh | Sync button slot |
|----|------|------|---|---|
| D5 | `home/home_screen.dart` | `ListView` in `_HomeBody` | `homeProvider.future` | `StrideScreenHero.trailing` |
| D2a | `plan/week_list_screen.dart` | `ListView.builder` in `_WeekList` | `weekListProvider.future` | — |
| D3 | `plan/session_detail_screen.dart` | `ListView` in `_SessionDetailBody` | `planDayProvider((date, idx)).future` | — |
| D8 | `activity/activity_detail_screen.dart` | `ListView` in `_DetailBody` | `activityDetailProvider(id).future` | — |
| E1 | `health/health_overview_screen.dart` | `ListView` in `_OverviewBody` | `healthOverviewProvider.future` | `StrideScreenHero.trailing` |
| G1 | `profile/profile_screen.dart` | `ListView` in `_ProfileBody` | `homeProvider.future` | — |
| E2 | `health/pmc_screen.dart` | `ListView`/`Column` | `pmcProvider(_days).future` | `StrideTopBar.actions` |
| E3 | `health/trends_screen.dart` | `ListView` | `trendsProvider.future` | `StrideTopBar.actions` |
| E4 | `health/ability_radar_screen.dart` | `ListView` | `abilitySnapshotProvider.future` | `StrideTopBar.actions` |
| E5 | `health/predictions_screen.dart` | `ListView` | `predictionsProvider.future` | `StrideTopBar.actions` |
| E6 | `health/pb_records_screen.dart` | `ListView` | `pbRecordsProvider.future` | `StrideTopBar.actions` |

D5 / E1 already have `StrideScreenHero`. E2–E6 still use `StrideTopBar`
from before the wave-1 refit; their sync button goes into `actions:`
until they receive a hero refit in wave 2.

G1 reads `homeProvider` for the lifetime stats and watch info, so its
pull-to-refresh invalidates `homeProvider` — same provider as D5. G1
gets no sync button because the screen is primarily account/menu
content, not watch-driven data.

## UX details

**Pull-to-refresh**
- `RefreshIndicator(color: StrideTokens.accent)` — the accent green.
- Indicator turns until `await ref.read(provider)` resolves. No toast,
  no SnackBar; the data updating is the signal.
- Errors flow into the screen's existing `AsyncValue.when(error: ...)`
  branch; we don't double-report.

**Sync button**

| State | Visual |
|------|--------|
| idle | 20 px `Icons.sync`, colour `StrideTokens.fgSoft` |
| syncing | 20 × 20 `CircularProgressIndicator(strokeWidth: 2, color: StrideTokens.accent)` |

Feedback:
- Success → `SnackBar('已同步')`.
- Error → `SnackBar('同步失败：<message>')`, error-coloured.

While `state.syncing == true` the GestureDetector's `onTap` is `null`
to disable re-entry from the same screen; cross-screen re-entry is
blocked by the `if (state.syncing) return;` guard inside the
controller.

`lastSyncedAt` is tracked but **not displayed** in this iteration; the
design mock doesn't specify a "last synced X" label. Wave 2 may add a
line under the hero or on G1.

## Error and edge cases

- **First-load `loading` state:** the screen shows a centre
  `CircularProgressIndicator` and does not render the `ListView`, so
  there is no surface to pull on. Refreshing only becomes available
  after first data load.
- **Error state:** same as above — the error column replaces the
  `ListView`, so pull-to-refresh isn't reachable. The existing "重试"
  button handles re-fetch in that state.
- **Pull while provider already invalidating:** Riverpod coalesces
  concurrent `read(.future)` to the same in-flight future; spinner
  awaits the in-flight one. Safe.
- **`autoDispose.family` providers (D8 / D3 / E2):** invalidate the
  invoked instance with the same params. Riverpod handles this.
- **401 during sync:** the existing Dio auth interceptor logs the user
  out and redirects to `/v2/auth/start`; the controller catches the
  `DioException` and surfaces "同步失败" but the redirect already
  happened, so the SnackBar is harmless.
- **Backgrounding mid-sync:** Flutter pauses the future but the server
  call continues on the backend. On resume the `await` resolves
  normally; if it timed out, `state.error` is set and a SnackBar
  appears.
- **`currentUserIdProvider == null`:** `triggerSync` no-ops. Should be
  unreachable because the redirect rules push unauthenticated users
  out of `/v2/*` before any data screen mounts.

## Testing

**`mobile/test/features_v2/_shared/widgets/refreshable_test.dart`**
1. Initial render shows `child` unchanged.
2. A simulated downward fling on the child triggers
   `ref.invalidate(provider)` (assert by tracking a counter on a mock
   provider).
3. With a mock that returns two distinct values across consecutive
   reads, a fling updates the rendered content.
4. When the second read throws, the indicator stops and the error is
   swallowed inside `StrideRefreshable` (the screen's own AsyncValue
   path handles surfacing).

**`mobile/test/features_v2/_shared/sync/sync_controller_test.dart`**
1. Initial `SyncState` is `(syncing: false, lastSyncedAt: null,
   error: null)`.
2. While `triggerSync()` is in flight, `state.syncing == true`.
3. On success, `state.syncing == false`, `state.lastSyncedAt` is set
   close to `DateTime.now()`, and `state.error == null`.
4. On `triggerSync` throwing, `state.syncing == false`, `state.error`
   is the thrown object, and `state.lastSyncedAt` is unchanged.
5. Re-entry guard: while syncing, a second `triggerSync()` returns
   immediately without re-calling `api.triggerSync` (verified by call
   counter on the mock API).
6. Provider invalidation: after a successful sync, each of the seven
   registered watch-data providers has been invalidated (verified by
   subscribing a listener that counts state-change events).

**Screen-level updates** (touch existing tests, no new ones for the
re-wrap):
- Replace inline `RefreshIndicator` assertions in `home_screen_test`
  with a check for `find.byType(StrideRefreshable<HomeData>)`.
- Add a single test for D5 + E1: "sync icon renders in
  `StrideScreenHero.trailing`; tapping it calls
  `SyncController.triggerSync`" (mock controller, assert call).

**Out of scope**
- E2E tests (the project has no e2e infrastructure).
- Visual regression / golden tests (the project has no golden setup).
- Adding pull-to-refresh tests to E2–E6 — those screens have no widget
  tests today; we'd be writing them from scratch which exceeds this
  iteration.

## Out-of-scope follow-ups

- Wave 2 hero refit for E2–E6 (then their sync buttons migrate from
  `StrideTopBar.actions` to `StrideScreenHero.trailing`).
- Surface `lastSyncedAt` somewhere ("上次同步 5/22 09:41" under the
  hero, or on G1).
- Cache freshness banner ("数据为 5 分钟前同步") when
  `DateTime.now().difference(lastSyncedAt) > threshold`.
- Move the invalidation list off a hard-coded set onto something
  declarative (e.g. each provider registers itself as "watch-data" via
  an extension or registry).
