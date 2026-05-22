# Mobile Pull-to-Refresh + Sync Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-22-mobile-pull-to-refresh-design.md`

**Goal:** Add pull-to-refresh to 11 v2 screens and an explicit COROS sync button to 6 watch-data screens (D5/E1/E2-E6), each backed by a single shared `StrideRefreshable` widget and a singleton `SyncController`.

**Architecture:** New shared module under `mobile/lib/features_v2/_shared/` exposes (a) `StrideRefreshable<T>`, a thin `RefreshIndicator` wrapper that owns the accent-coloured indicator + `ref.refresh(provider.future)` call, and (b) `SyncController`, a `NotifierProvider`-backed singleton that owns "currently syncing" state and a hard-coded invalidation set. Screens consume both via Riverpod with no per-screen `_doSync` plumbing.

**Tech Stack:** Flutter 3.40+ · Dart 3 records · `flutter_riverpod` 2.x (`NotifierProvider`, `Refreshable`) · `RefreshIndicator` from `flutter/material.dart`.

**Branch:** `zhaochy/mobile-pull-to-refresh` (base `origin/master`, spec already committed as `ded7c74`).

**Environment caveat:** No Flutter SDK is installed in this worktree. The TDD steps in this plan still write the test first, but the "run test to see it fail / pass" steps verify by inspection + a paren/brace balance script (`scripts/dart_balance.py`, created in Task 0). The real green/red signal comes from the **Mobile Build (Android)** GitHub Actions workflow, which is triggered on push to a tagged PR branch via the `pull_request` filter and on push to master. Task N final pushes the branch and watches that workflow.

**Spec correction (carry into all tasks):** The design doc names a `predictionsProvider`. The actual code has `racePredictionProvider` (and `racePredictionHistoryProvider`) in `mobile/lib/features_v2/health/providers/race_prediction_provider.dart`. All references below use the real names.

---

## File structure

```
mobile/lib/features_v2/_shared/
├── widgets/
│   ├── refreshable.dart          NEW — StrideRefreshable<T>
│   └── (existing widgets…)
└── sync/                          NEW dir
    └── sync_controller.dart       NEW — SyncState + SyncController + provider

mobile/test/features_v2/_shared/
├── widgets/
│   └── refreshable_test.dart      NEW
└── sync/                          NEW dir
    └── sync_controller_test.dart  NEW

scripts/
└── dart_balance.py                NEW — paren/brace/bracket balance check
```

Touched screens (11): `home/home_screen.dart`, `plan/week_list_screen.dart`, `plan/session_detail_screen.dart`, `activity/activity_detail_screen.dart`, `health/health_overview_screen.dart`, `profile/profile_screen.dart`, `health/pmc_screen.dart`, `health/trends_screen.dart`, `health/ability_radar_screen.dart`, `health/predictions_screen.dart`, `health/pb_records_screen.dart`.

Touched tests (1 new + minimal updates): adds 2 new test files + updates `home/home_screen_test.dart` and `health/health_overview_screen_test.dart` to assert the sync button.

---

### Task 0: Vendor a paren-balance script (local verification helper)

**Files:**
- Create: `scripts/dart_balance.py`

- [ ] **Step 1: Create the balance script**

```python
#!/usr/bin/env python3
"""Quick syntactic-balance check for Dart files when no Dart SDK is available.

Strips // line comments and /* */ block comments, then null-replaces the
*contents* of single- and double-quoted strings (preserving newlines so line
numbers in error messages line up). Counts (), {}, [] in what remains and
flags any imbalance.

Usage:  python3 scripts/dart_balance.py path/one.dart path/two.dart
Exit 0 if all files balance; 1 otherwise.
"""

import re
import sys


def _strip(src: str) -> str:
    s = re.sub(r"//[^\n]*", "", src)
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.S)

    def collapse_string(match: re.Match[str]) -> str:
        raw = match.group(0)
        nls = raw.count("\n")
        return raw[0] + ("\n" * nls) + raw[-1]

    s = re.sub(r"'(?:\\.|[^'\\])*'", collapse_string, s)
    s = re.sub(r'"(?:\\.|[^"\\])*"', collapse_string, s)
    return s


def check(path: str) -> bool:
    with open(path, "r", encoding="utf-8") as fp:
        stripped = _strip(fp.read())
    pairs = (("(", ")"), ("{", "}"), ("[", "]"))
    ok = all(stripped.count(a) == stripped.count(b) for a, b in pairs)
    diff = " ".join(
        f"{a}:{stripped.count(a)}/{b}:{stripped.count(b)}" for a, b in pairs
    )
    print(("OK   " if ok else "FAIL "), path, diff)
    return ok


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: dart_balance.py file.dart [file.dart ...]", file=sys.stderr)
        sys.exit(2)
    if all(check(p) for p in sys.argv[1:]):
        sys.exit(0)
    sys.exit(1)
```

- [ ] **Step 2: Smoke-test it against an existing widget**

Run: `python3 scripts/dart_balance.py mobile/lib/features_v2/_shared/widgets/screen_hero.dart`
Expected: `OK   mobile/.../screen_hero.dart (:25/:25) {:3/:3} [:4/:4]`

- [ ] **Step 3: Commit**

```bash
git add scripts/dart_balance.py
git commit -m "tools: dart paren/brace balance check (used when no SDK available)"
```

---

### Task 1: `StrideRefreshable<T>` widget

**Files:**
- Create: `mobile/lib/features_v2/_shared/widgets/refreshable.dart`
- Create: `mobile/test/features_v2/_shared/widgets/refreshable_test.dart`

- [ ] **Step 1: Write the failing widget test**

```dart
// mobile/test/features_v2/_shared/widgets/refreshable_test.dart
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/features_v2/_shared/widgets/refreshable.dart';

final _testProvider = FutureProvider.autoDispose<int>((ref) async => 1);

Future<void> _pumpWith(WidgetTester tester, FutureOr<int> Function() factory) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        _testProvider.overrideWith((ref) async => factory()),
      ],
      child: MaterialApp(
        home: Scaffold(
          body: StrideRefreshable<int>(
            provider: _testProvider.future,
            child: Consumer(
              builder: (context, ref, _) {
                final v = ref.watch(_testProvider);
                return ListView(
                  children: [
                    SizedBox(
                      height: 800,
                      child: Center(child: Text('value=${v.valueOrNull ?? "-"}')),
                    ),
                  ],
                );
              },
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('renders child unchanged on initial pump', (tester) async {
    var calls = 0;
    await _pumpWith(tester, () {
      calls++;
      return 1;
    });
    expect(find.text('value=1'), findsOneWidget);
    expect(calls, 1);
  });

  testWidgets('pull triggers provider re-fetch', (tester) async {
    var calls = 0;
    await _pumpWith(tester, () {
      calls++;
      return calls;
    });
    expect(find.text('value=1'), findsOneWidget);

    await tester.fling(find.byType(ListView), const Offset(0, 300), 1000);
    await tester.pumpAndSettle();

    expect(calls, greaterThanOrEqualTo(2));
    expect(find.text('value=2'), findsOneWidget);
  });

  testWidgets('errors from provider are swallowed (no rethrow)', (tester) async {
    await _pumpWith(tester, () => throw Exception('boom'));
    // Provider error surfaces inside the screen, but the widget itself
    // must not throw during pull — it only owns the spinner.
    await tester.fling(find.byType(ListView), const Offset(0, 300), 1000);
    await tester.pumpAndSettle();
    // Reaching here without an uncaught test failure proves the swallow.
    expect(tester.takeException(), isNull);
  });
}
```

- [ ] **Step 2: (Try to) run the failing test**

If `flutter` is on `PATH`:

Run: `cd mobile && flutter test test/features_v2/_shared/widgets/refreshable_test.dart`
Expected: FAIL — `Target of URI doesn't exist: 'package:stride/features_v2/_shared/widgets/refreshable.dart'.`

If `flutter` is **not** available (this worktree): skip; the failure mode is obvious by inspection (the import target doesn't exist). Proceed to Step 3.

- [ ] **Step 3: Implement the widget**

```dart
// mobile/lib/features_v2/_shared/widgets/refreshable.dart
//
// StrideRefreshable<T> — single-purpose RefreshIndicator wrapper.
//
// Pull-to-refresh triggers `ref.refresh(provider)` (Riverpod's
// invalidate-and-return-new-future combinator), keeping the spinner
// active until the awaited future resolves. Provider-side errors are
// caught here so the indicator stops cleanly; the screen's own
// AsyncValue.when(error: ...) branch is the one that renders error UI.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/theme/tokens.dart';

class StrideRefreshable<T> extends ConsumerWidget {
  const StrideRefreshable({
    super.key,
    required this.provider,
    required this.child,
  });

  /// The `.future` accessor of a `FutureProvider` (basic, autoDispose,
  /// or family-invoked).  `Refreshable<Future<T>>` is the common
  /// supertype that supports both `ref.read` and `ref.refresh`.
  final Refreshable<Future<T>> provider;

  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return RefreshIndicator(
      color: StrideTokens.accent,
      onRefresh: () async {
        try {
          await ref.refresh(provider);
        } catch (_) {
          // Screen owns its own error UI via AsyncValue.when(error:).
        }
      },
      child: child,
    );
  }
}
```

- [ ] **Step 4: Verify balance + (re-)run tests**

Run: `python3 scripts/dart_balance.py mobile/lib/features_v2/_shared/widgets/refreshable.dart mobile/test/features_v2/_shared/widgets/refreshable_test.dart`
Expected: both `OK`.

If `flutter` is available: `cd mobile && flutter test test/features_v2/_shared/widgets/refreshable_test.dart`. Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/features_v2/_shared/widgets/refreshable.dart mobile/test/features_v2/_shared/widgets/refreshable_test.dart
git commit -m "feat(mobile): StrideRefreshable widget"
```

---

### Task 2: `SyncController` + `SyncState`

**Files:**
- Create: `mobile/lib/features_v2/_shared/sync/sync_controller.dart`
- Create: `mobile/test/features_v2/_shared/sync/sync_controller_test.dart`

- [ ] **Step 1: Confirm the watch-data providers exist (already verified, recap)**

These imports must resolve in the controller file:

```
mobile/lib/features_v2/home/providers/home_provider.dart                  homeProvider
mobile/lib/features_v2/health/providers/health_overview_provider.dart     healthOverviewProvider
mobile/lib/features_v2/health/providers/pmc_provider.dart                 pmcProvider (family)
mobile/lib/features_v2/health/providers/ability_snapshot_provider.dart    abilitySnapshotProvider
mobile/lib/features_v2/health/providers/race_prediction_provider.dart     racePredictionProvider, racePredictionHistoryProvider
mobile/lib/features_v2/health/providers/pb_records_provider.dart          pbRecordsProvider
mobile/lib/features_v2/health/providers/trends_provider.dart              trendsProvider
```

If any are absent at run time, the build will fail with `Undefined name`. Re-verify via `grep -rn '^final <name>Provider' mobile/lib/features_v2/`.

- [ ] **Step 2: Write the failing controller test**

```dart
// mobile/test/features_v2/_shared/sync/sync_controller_test.dart
import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/core/auth/current_user.dart';
import 'package:stride/data/api/stride_api.dart';
import 'package:stride/features_v2/_shared/sync/sync_controller.dart';

class _StubApi extends StrideApi {
  _StubApi() : super(Dio());

  int calls = 0;
  Completer<void> _completer = Completer<void>();

  void resolveOk() {
    _completer.complete();
    _completer = Completer<void>();
  }

  void resolveError(Object e) {
    _completer.completeError(e);
    _completer = Completer<void>();
  }

  @override
  Future<void> triggerSync(String user, {bool full = false}) async {
    calls++;
    await _completer.future;
  }
}

ProviderContainer _container(_StubApi api) {
  return ProviderContainer(
    overrides: [
      strideApiProvider.overrideWithValue(api),
      currentUserIdProvider.overrideWithValue('user-001'),
    ],
  );
}

void main() {
  test('initial state is idle (syncing=false, lastSyncedAt=null, error=null)', () {
    final api = _StubApi();
    final c = _container(api);
    addTearDown(c.dispose);
    final state = c.read(syncControllerProvider);
    expect(state.syncing, isFalse);
    expect(state.lastSyncedAt, isNull);
    expect(state.error, isNull);
  });

  test('syncing flag flips true during, false after', () async {
    final api = _StubApi();
    final c = _container(api);
    addTearDown(c.dispose);

    final notifier = c.read(syncControllerProvider.notifier);
    final fut = notifier.triggerSync();

    // Pump one microtask so triggerSync sets state before we read it.
    await Future<void>.delayed(Duration.zero);
    expect(c.read(syncControllerProvider).syncing, isTrue);

    api.resolveOk();
    await fut;
    expect(c.read(syncControllerProvider).syncing, isFalse);
  });

  test('successful sync sets lastSyncedAt and clears error', () async {
    final api = _StubApi();
    final c = _container(api);
    addTearDown(c.dispose);

    final notifier = c.read(syncControllerProvider.notifier);
    final fut = notifier.triggerSync();
    api.resolveOk();
    await fut;

    final state = c.read(syncControllerProvider);
    expect(state.syncing, isFalse);
    expect(state.lastSyncedAt, isNotNull);
    expect(state.error, isNull);
  });

  test('failed sync sets error and preserves prior lastSyncedAt', () async {
    final api = _StubApi();
    final c = _container(api);
    addTearDown(c.dispose);

    final notifier = c.read(syncControllerProvider.notifier);

    // First sync: success.
    final ok = notifier.triggerSync();
    api.resolveOk();
    await ok;
    final priorTimestamp = c.read(syncControllerProvider).lastSyncedAt;
    expect(priorTimestamp, isNotNull);

    // Second sync: failure.
    final bad = notifier.triggerSync();
    api.resolveError(Exception('boom'));
    await expectLater(bad, throwsA(isA<Exception>()));

    final state = c.read(syncControllerProvider);
    expect(state.syncing, isFalse);
    expect(state.error, isA<Exception>());
    expect(state.lastSyncedAt, equals(priorTimestamp));
  });

  test('re-entry while syncing is a no-op', () async {
    final api = _StubApi();
    final c = _container(api);
    addTearDown(c.dispose);

    final notifier = c.read(syncControllerProvider.notifier);
    final first = notifier.triggerSync();
    await Future<void>.delayed(Duration.zero);
    final second = notifier.triggerSync();

    api.resolveOk();
    await Future.wait([first, second]);

    expect(api.calls, 1, reason: 'second call must be guarded out');
  });
}
```

- [ ] **Step 3: (Try to) run the failing test**

If `flutter` available: `cd mobile && flutter test test/features_v2/_shared/sync/sync_controller_test.dart` → FAIL on the missing import. Otherwise inspect and proceed.

- [ ] **Step 4: Implement `SyncController`**

```dart
// mobile/lib/features_v2/_shared/sync/sync_controller.dart
//
// SyncController — process-wide singleton owning the in-flight
// COROS sync state.  Re-entry while syncing is silently dropped so a
// second tap on any sync button (or on a different screen's button)
// while a sync is running is a no-op.
//
// Successful sync invalidates every watch-data provider so any active
// screen re-fetches.  The list is hard-coded; future watch-data
// providers must be appended here.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/current_user.dart';
import '../../../data/api/stride_api.dart';
import '../../health/providers/ability_snapshot_provider.dart';
import '../../health/providers/health_overview_provider.dart';
import '../../health/providers/pb_records_provider.dart';
import '../../health/providers/pmc_provider.dart';
import '../../health/providers/race_prediction_provider.dart';
import '../../health/providers/trends_provider.dart';
import '../../home/providers/home_provider.dart';

class SyncState {
  const SyncState({
    this.syncing = false,
    this.lastSyncedAt,
    this.error,
  });

  final bool syncing;
  final DateTime? lastSyncedAt;
  final Object? error;

  SyncState copyWith({
    bool? syncing,
    DateTime? lastSyncedAt,
    Object? error,
    bool clearError = false,
  }) {
    return SyncState(
      syncing: syncing ?? this.syncing,
      lastSyncedAt: lastSyncedAt ?? this.lastSyncedAt,
      error: clearError ? null : (error ?? this.error),
    );
  }
}

class SyncController extends Notifier<SyncState> {
  @override
  SyncState build() => const SyncState();

  /// Trigger a server-side COROS sync.  No-op (returns the resolved
  /// future of the in-flight call) if a sync is already running.
  Future<void> triggerSync() async {
    if (state.syncing) return;
    final userId = ref.read(currentUserIdProvider);
    if (userId == null) return;

    state = state.copyWith(syncing: true, clearError: true);
    try {
      await ref.read(strideApiProvider).triggerSync(userId);
      // Invalidate the watch-data providers in order so dependents
      // re-fetch on next watch.  pmcProvider is a family — invalidating
      // the family invalidates every param instance.
      ref.invalidate(homeProvider);
      ref.invalidate(healthOverviewProvider);
      ref.invalidate(pmcProvider);
      ref.invalidate(abilitySnapshotProvider);
      ref.invalidate(racePredictionProvider);
      ref.invalidate(racePredictionHistoryProvider);
      ref.invalidate(pbRecordsProvider);
      ref.invalidate(trendsProvider);
      state = state.copyWith(
        syncing: false,
        lastSyncedAt: DateTime.now(),
        clearError: true,
      );
    } catch (e) {
      state = state.copyWith(syncing: false, error: e);
      rethrow;
    }
  }
}

final syncControllerProvider =
    NotifierProvider<SyncController, SyncState>(SyncController.new);
```

- [ ] **Step 5: Verify balance**

Run: `python3 scripts/dart_balance.py mobile/lib/features_v2/_shared/sync/sync_controller.dart mobile/test/features_v2/_shared/sync/sync_controller_test.dart`
Expected: both `OK`.

If `flutter` available: `cd mobile && flutter test test/features_v2/_shared/sync/sync_controller_test.dart` → all 5 passes.

- [ ] **Step 6: Commit**

```bash
git add mobile/lib/features_v2/_shared/sync/sync_controller.dart mobile/test/features_v2/_shared/sync/sync_controller_test.dart
git commit -m "feat(mobile): SyncController with re-entry guard + watch-data invalidation"
```

---

### Task 3: Wire D5 home (refresh + sync button)

**Files:**
- Modify: `mobile/lib/features_v2/home/home_screen.dart`
- Modify: `mobile/test/features_v2/home/home_screen_test.dart`

- [ ] **Step 1: Read current D5 to confirm shapes**

Run: `sed -n '1,100p' mobile/lib/features_v2/home/home_screen.dart`
Expected: confirms the existing `_doSync` method (~lines 53-63), the inline `RefreshIndicator` wrapping a `ListView` inside `_HomeBody.build`, and a `StrideScreenHero(eyebrow: ..., title: ..., deck: ...)` call with no `trailing:` argument.

- [ ] **Step 2: Replace `_doSync` and `RefreshIndicator` + add sync trailing**

Apply two edits to `mobile/lib/features_v2/home/home_screen.dart`:

(a) Replace the import block (around line 14-24) to add the new modules and drop unused ones:

```dart
import '../../core/auth/current_user.dart';
import '../../core/router/routes_v2.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../_shared/sync/sync_controller.dart';
import '../_shared/widgets/refreshable.dart';
import '../_shared/widgets/screen_hero.dart';
import '../_shared/widgets/section_header.dart';
import '../_shared/widgets/stat_row.dart';
import 'models/home_data.dart';
import 'providers/home_provider.dart';
import 'widgets/status_ring_card.dart';
```

(Note: removes `import '../../data/api/stride_api.dart';` since `_doSync` is gone.)

(b) Replace the `HomeScreen.build` body's `_doSync` and the `_HomeBody.build` `RefreshIndicator`:

```dart
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final homeAsync = ref.watch(homeProvider);

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      body: homeAsync.when(
        loading: () => const Center(
          child: CircularProgressIndicator(color: StrideTokens.accent),
        ),
        error: (err, _) => _ErrorBody(
          message: err.toString(),
          onRetry: () => ref.invalidate(homeProvider),
        ),
        data: (data) => _HomeBody(data: data),
      ),
    );
  }
}
```

```dart
class _HomeBody extends ConsumerWidget {
  const _HomeBody({required this.data});
  final HomeData data;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final syncState = ref.watch(syncControllerProvider);
    final messenger = ScaffoldMessenger.of(context);

    return SafeArea(
      bottom: false,
      child: StrideRefreshable<HomeData>(
        provider: homeProvider.future,
        child: ListView(
          padding: EdgeInsets.zero,
          children: [
            StrideScreenHero(
              eyebrow: '主页 · 本周',
              title: _heroTitle(data.planState),
              deck: _heroDeck(data),
              trailing: _SyncIcon(
                syncing: syncState.syncing,
                onTap: syncState.syncing
                    ? null
                    : () async {
                        try {
                          await ref
                              .read(syncControllerProvider.notifier)
                              .triggerSync();
                          messenger.showSnackBar(
                            const SnackBar(content: Text('已同步')),
                          );
                        } catch (e) {
                          messenger.showSnackBar(
                            SnackBar(content: Text('同步失败：$e')),
                          );
                        }
                      },
              ),
            ),
            // … keep the existing inner Padding(Column(...)) block
            //    untouched (StatusRingCard, _PlanCta, WfSectionHeader, etc.)
          ],
        ),
      ),
    );
  }

  String _heroTitle(String planState) {/* unchanged */}
  String _heroDeck(HomeData data) {/* unchanged */}
  String _fmtDuration(int seconds) {/* unchanged */}
}
```

(c) Add the `_SyncIcon` private widget near `_PlanCta`:

```dart
class _SyncIcon extends StatelessWidget {
  const _SyncIcon({required this.syncing, required this.onTap});
  final bool syncing;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    if (syncing) {
      return const SizedBox(
        width: 20,
        height: 20,
        child: CircularProgressIndicator(
          strokeWidth: 2,
          color: StrideTokens.accent,
        ),
      );
    }
    return GestureDetector(
      onTap: onTap,
      child: const Icon(Icons.sync, size: 20, color: StrideTokens.fgSoft),
    );
  }
}
```

(d) Delete the now-unused `_doSync` method on `HomeScreen` and the imports it relied on (`stride_api.dart`, `current_user.dart` — keep the latter if `_PlanCta` or downstream still uses it; verify by grep in Step 4).

- [ ] **Step 3: Update D5 widget test to assert the new sync icon**

Add a new test to `mobile/test/features_v2/home/home_screen_test.dart` (append before the final `}`):

```dart
testWidgets('sync icon renders in hero trailing slot', (tester) async {
  // Setup is the standard _pump used by other tests in this file.
  await _pump(tester, AsyncData(_testHomeData));
  expect(find.byIcon(Icons.sync), findsOneWidget);
});

testWidgets('tapping sync icon calls SyncController.triggerSync', (tester) async {
  // Use a recording override on syncControllerProvider; see the pattern
  // in mobile/test/features_v2/_shared/sync/sync_controller_test.dart.
  final calls = <DateTime>[];
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        // … reuse existing _pump overrides for homeProvider + auth
        syncControllerProvider.overrideWith(_RecordingSyncController.new),
      ],
      child: const MaterialApp(home: HomeScreen()),
    ),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.byIcon(Icons.sync));
  await tester.pumpAndSettle();
  expect(_RecordingSyncController.lastInstance!.triggerCalls, 1);
});
```

Where `_RecordingSyncController` is a test-local helper that extends `SyncController` and increments a counter on each `triggerSync()` call. If wiring the override turns out to be awkward (the family-style override API has changed across riverpod versions), fall back to asserting just the icon's presence + tappability and let the controller's own unit test (Task 2) cover the call semantics.

- [ ] **Step 4: Static verification**

Run: `python3 scripts/dart_balance.py mobile/lib/features_v2/home/home_screen.dart mobile/test/features_v2/home/home_screen_test.dart`
Expected: both `OK`.

Run: `grep -n "_doSync\|api.triggerSync" mobile/lib/features_v2/home/home_screen.dart`
Expected: zero hits.

Run: `grep -n "^import" mobile/lib/features_v2/home/home_screen.dart`
Inspect: `stride_api.dart` no longer imported; `refreshable.dart` + `sync_controller.dart` are.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/features_v2/home/home_screen.dart mobile/test/features_v2/home/home_screen_test.dart
git commit -m "feat(mobile): D5 — pull-to-refresh + sync button via SyncController"
```

---

### Task 4: Wire E1 health overview (refresh + sync button)

**Files:**
- Modify: `mobile/lib/features_v2/health/health_overview_screen.dart`
- Modify: `mobile/test/features_v2/health/health_overview_screen_test.dart`

Mirror Task 3 with three differences: provider is `healthOverviewProvider`, the body widget is `_OverviewBody`, and the hero already exists (eyebrow `身体指标 · 今日`, title `健康概览`) but lacks a `trailing:`.

- [ ] **Step 1: Read E1 to locate edit points**

Run: `sed -n '24,65p' mobile/lib/features_v2/health/health_overview_screen.dart`
Expected: the existing `Column` with `StrideScreenHero(eyebrow: '身体指标 · 今日', title: '健康概览', ...)` and an `Expanded(child: async.when(...))`.

- [ ] **Step 2: Wrap `_OverviewBody`'s `ListView` with `StrideRefreshable` and add hero `trailing`**

In `health_overview_screen.dart`, add imports:

```dart
import '../_shared/sync/sync_controller.dart';
import '../_shared/widgets/refreshable.dart';
```

Replace the `StrideScreenHero(...)` call in `HealthOverviewScreen.build` to include `trailing`:

```dart
Consumer(
  builder: (context, ref, _) {
    final syncState = ref.watch(syncControllerProvider);
    final messenger = ScaffoldMessenger.of(context);
    return StrideScreenHero(
      eyebrow: '身体指标 · 今日',
      title: '健康概览',
      deck: '同步自手表的静息心率、HRV、训练负荷与睡眠。',
      trailing: _SyncIcon(
        syncing: syncState.syncing,
        onTap: syncState.syncing
            ? null
            : () async {
                try {
                  await ref
                      .read(syncControllerProvider.notifier)
                      .triggerSync();
                  messenger.showSnackBar(
                    const SnackBar(content: Text('已同步')),
                  );
                } catch (e) {
                  messenger.showSnackBar(
                    SnackBar(content: Text('同步失败：$e')),
                  );
                }
              },
      ),
    );
  },
),
```

Inside `_OverviewBody.build`, change the outer `ListView(...)` into:

```dart
return StrideRefreshable<HealthOverview>(
  provider: healthOverviewProvider.future,
  child: ListView(
    padding: const EdgeInsets.all(StrideTokens.spaceLg),
    children: [/* unchanged */],
  ),
);
```

Add the same `_SyncIcon` widget at the bottom of the file (it lives once per screen for now; extracting it as a shared widget waits for the third-or-later caller).

- [ ] **Step 3: Update E1 test to assert sync icon presence**

Append to `mobile/test/features_v2/health/health_overview_screen_test.dart`:

```dart
testWidgets('hero trailing renders sync icon', (tester) async {
  await _pump(tester, const AsyncData(_fullOverview));
  expect(find.byIcon(Icons.sync), findsOneWidget);
});
```

- [ ] **Step 4: Static verification**

Run: `python3 scripts/dart_balance.py mobile/lib/features_v2/health/health_overview_screen.dart mobile/test/features_v2/health/health_overview_screen_test.dart`
Expected: both `OK`.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/features_v2/health/health_overview_screen.dart mobile/test/features_v2/health/health_overview_screen_test.dart
git commit -m "feat(mobile): E1 — pull-to-refresh + sync button"
```

---

### Task 5: Wire D2a, D3, D8, G1 (refresh only — no sync button)

**Files:**
- Modify: `mobile/lib/features_v2/plan/week_list_screen.dart`
- Modify: `mobile/lib/features_v2/plan/session_detail_screen.dart`
- Modify: `mobile/lib/features_v2/activity/activity_detail_screen.dart`
- Modify: `mobile/lib/features_v2/profile/profile_screen.dart`

Each edit is the same shape: import `refreshable.dart`, wrap the body's `ListView` (or the one inside the lazy `_…Body`) with `StrideRefreshable<T>(provider: <provider>.future, child: ListView(...))`.

- [ ] **Step 1: D2a — week list**

In `mobile/lib/features_v2/plan/week_list_screen.dart`, add `import '../_shared/widgets/refreshable.dart';` next to the other `_shared/widgets/...` imports. In `_WeekList.build`, change:

```dart
return ListView.builder(
  padding: const EdgeInsets.fromLTRB(...),
  itemCount: filtered.length,
  itemBuilder: ...,
);
```

to:

```dart
return StrideRefreshable<List<WeekListItem>>(
  provider: weekListProvider.future,
  child: ListView.builder(
    padding: const EdgeInsets.fromLTRB(...),
    itemCount: filtered.length,
    itemBuilder: ...,
  ),
);
```

- [ ] **Step 2: D3 — session detail**

In `mobile/lib/features_v2/plan/session_detail_screen.dart`, add `import '../_shared/widgets/refreshable.dart';`. The `_SessionDetailBody.build` wraps a `ListView` in a `Column`. Change the inner `Expanded(child: ListView(...))` so the `child:` is `StrideRefreshable<DayPlan>(provider: planDayProvider((date: widget.date, sessionIndex: widget.sessionIndex)).future, child: ListView(...))`.

Note the family-invocation `planDayProvider((date: ..., sessionIndex: ...))` — `.future` is read off that record-invoked instance.

- [ ] **Step 3: D8 — activity detail**

In `mobile/lib/features_v2/activity/activity_detail_screen.dart`, add `import '../_shared/widgets/refreshable.dart';`. In `_DetailBody.build` the outer `ListView(...)` becomes:

```dart
return StrideRefreshable<ActivityDetailV2>(
  provider: activityDetailProvider(activityId).future,
  child: ListView(...),
);
```

- [ ] **Step 4: G1 — profile**

In `mobile/lib/features_v2/profile/profile_screen.dart`, add `import '../_shared/widgets/refreshable.dart';`. In `_ProfileBody.build`, wrap the outer `ListView` (children list with `_UserHeader`, `_Divider`, etc.) with `StrideRefreshable<HomeData>(provider: homeProvider.future, child: ListView(...))`. G1 watches `homeProvider` so refreshing it re-pulls the lifetime stats + watch info.

- [ ] **Step 5: Static verification (all four files)**

Run:

```bash
python3 scripts/dart_balance.py \
  mobile/lib/features_v2/plan/week_list_screen.dart \
  mobile/lib/features_v2/plan/session_detail_screen.dart \
  mobile/lib/features_v2/activity/activity_detail_screen.dart \
  mobile/lib/features_v2/profile/profile_screen.dart
```

Expected: all four `OK`.

- [ ] **Step 6: Commit**

```bash
git add mobile/lib/features_v2/plan/week_list_screen.dart \
        mobile/lib/features_v2/plan/session_detail_screen.dart \
        mobile/lib/features_v2/activity/activity_detail_screen.dart \
        mobile/lib/features_v2/profile/profile_screen.dart
git commit -m "feat(mobile): D2a/D3/D8/G1 — pull-to-refresh"
```

---

### Task 6: Wire E2-E6 (refresh + sync button in `StrideTopBar.actions`)

**Files:**
- Modify: `mobile/lib/features_v2/health/pmc_screen.dart`
- Modify: `mobile/lib/features_v2/health/trends_screen.dart`
- Modify: `mobile/lib/features_v2/health/ability_radar_screen.dart`
- Modify: `mobile/lib/features_v2/health/predictions_screen.dart`
- Modify: `mobile/lib/features_v2/health/pb_records_screen.dart`

These screens still use `StrideTopBar(title: '…')` (no hero refit yet). The sync button goes into `StrideTopBar.actions: [_SyncIcon(...)]`.

- [ ] **Step 1: Promote `_SyncIcon` to a shared widget (third caller justifies extraction)**

Create `mobile/lib/features_v2/_shared/widgets/sync_icon.dart`:

```dart
// SyncIconButton — small icon that toggles to a spinner while a
// COROS sync is in flight.  Watches syncControllerProvider so all
// instances animate together; tap is a no-op while syncing.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/theme/tokens.dart';
import '../sync/sync_controller.dart';

class SyncIconButton extends ConsumerWidget {
  const SyncIconButton({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final syncState = ref.watch(syncControllerProvider);
    if (syncState.syncing) {
      return const SizedBox(
        width: 20,
        height: 20,
        child: CircularProgressIndicator(
          strokeWidth: 2,
          color: StrideTokens.accent,
        ),
      );
    }
    return GestureDetector(
      onTap: () async {
        final messenger = ScaffoldMessenger.of(context);
        try {
          await ref.read(syncControllerProvider.notifier).triggerSync();
          messenger.showSnackBar(const SnackBar(content: Text('已同步')));
        } catch (e) {
          messenger.showSnackBar(SnackBar(content: Text('同步失败：$e')));
        }
      },
      child: const Icon(Icons.sync, size: 20, color: StrideTokens.fgSoft),
    );
  }
}
```

Then in `home_screen.dart` (Task 3) and `health_overview_screen.dart` (Task 4), replace the inline `_SyncIcon` with `const SyncIconButton()` (deleting the inline private classes).

- [ ] **Step 2: For each E2-E6 screen**

Apply this pattern to all five files:

```dart
// imports
import '../_shared/widgets/refreshable.dart';
import '../_shared/widgets/sync_icon.dart';
```

```dart
return Scaffold(
  backgroundColor: StrideTokens.bg,
  appBar: const StrideTopBar(
    title: '<existing title>',
    actions: [SyncIconButton()],
  ),
  body: async.when(
    loading: () => const Center(child: CircularProgressIndicator()),
    error: ...,
    data: (data) => StrideRefreshable<DATA_TYPE>(
      provider: <provider>.future,
      child: ListView(...),
    ),
  ),
);
```

Per-screen provider + data type:

| File | Provider | Data type |
|------|----------|-----------|
| `pmc_screen.dart` | `pmcProvider(_days)` | `PmcData` |
| `trends_screen.dart` | `trendsProvider` | `TrendsData` (verify via `cat mobile/lib/features_v2/health/models/`) |
| `ability_radar_screen.dart` | `abilitySnapshotProvider` | `AbilitySnapshot` |
| `predictions_screen.dart` | `racePredictionProvider` | (verify type) |
| `pb_records_screen.dart` | `pbRecordsProvider` | `List<PbRecord>` |

Confirm exact data-type names with `grep -n 'FutureProvider' mobile/lib/features_v2/health/providers/<file>` before writing the `<T>` argument; mismatched generics fail at compile.

Note: `pmc_screen` uses a family-invoked provider parametrized by `_days`. The `_days` field lives on the screen state — make sure the `StrideRefreshable` rebuilds with the current `_days` when the user switches range. Wrapping the body widget already gives this for free (the widget rebuilds on `setState`).

Note: `predictions_screen` watches *two* providers — `racePredictionProvider` and `racePredictionHistoryProvider`. Pull-to-refresh only invalidates the primary (`racePredictionProvider`). After a sync via the button, both are invalidated by `SyncController`.

- [ ] **Step 3: Static verification**

Run:

```bash
python3 scripts/dart_balance.py \
  mobile/lib/features_v2/_shared/widgets/sync_icon.dart \
  mobile/lib/features_v2/health/pmc_screen.dart \
  mobile/lib/features_v2/health/trends_screen.dart \
  mobile/lib/features_v2/health/ability_radar_screen.dart \
  mobile/lib/features_v2/health/predictions_screen.dart \
  mobile/lib/features_v2/health/pb_records_screen.dart
```

Expected: all `OK`.

Run: `grep -rn 'class _SyncIcon' mobile/lib/features_v2/`. Expected: zero hits (Step 1 deleted both inline copies).

- [ ] **Step 4: Commit**

```bash
git add mobile/lib/features_v2/_shared/widgets/sync_icon.dart \
        mobile/lib/features_v2/health/pmc_screen.dart \
        mobile/lib/features_v2/health/trends_screen.dart \
        mobile/lib/features_v2/health/ability_radar_screen.dart \
        mobile/lib/features_v2/health/predictions_screen.dart \
        mobile/lib/features_v2/health/pb_records_screen.dart \
        mobile/lib/features_v2/home/home_screen.dart \
        mobile/lib/features_v2/health/health_overview_screen.dart
git commit -m "feat(mobile): E2-E6 — pull-to-refresh + shared SyncIconButton"
```

---

### Task 7: Open PR + watch Mobile Build CI

- [ ] **Step 1: Push the branch**

```bash
git push -u origin zhaochy/mobile-pull-to-refresh
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --base master --head zhaochy/mobile-pull-to-refresh \
  --title "feat(mobile): pull-to-refresh + manual sync button across v2 screens" \
  --body "$(cat <<'EOF'
## Summary
Implements docs/superpowers/specs/2026-05-22-mobile-pull-to-refresh-design.md.
Adds:
- StrideRefreshable<T> shared widget (RefreshIndicator + ref.refresh).
- SyncController NotifierProvider — singleton sync state, re-entry guard, fixed invalidation set.
- Pull-to-refresh on D5/D2a/D3/D8/E1/G1/E2-E6 (11 screens).
- Manual sync button on D5/E1 (StrideScreenHero.trailing) and E2-E6 (StrideTopBar.actions).

## Test plan
- [ ] CI Mobile Build (Android) passes (Backend + Frontend should be untouched, expected green).
- [ ] Manual on emulator: pull each of the 11 screens; verify accent-coloured spinner and data refresh.
- [ ] Manual: tap the sync button on D5/E1/E2-E6; verify spinner across all 6 simultaneously, SnackBar on success, no double-fire when tapping twice fast.

## Out of scope (per spec)
- Surfacing lastSyncedAt in the UI.
- Hero refit for E2-E6.
EOF
)"
```

- [ ] **Step 3: Watch the Mobile Build (Android) workflow**

```bash
gh run watch $(gh run list --branch zhaochy/mobile-pull-to-refresh --workflow="Mobile Build (Android)" --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status
```

If the run fails:
- `gh run view <id> --log-failed | grep -i 'error\|failed\|exception' | head -30`
- Common failure modes:
  - **`Undefined name 'fooProvider'`** — a provider rename happened; verify against `grep -rn '^final fooProvider' mobile/lib/`.
  - **`Type 'Refreshable<Future<T>>' not found`** — Riverpod version mismatch; switch the field type to `ProviderListenable<Future<T>>` and cast at the call site.
  - **`InvalidArgumentError: …family… is not the same key`** — when overriding a family-invoked provider, the override must use a value that's `==` to the widget's call. Mock at the API layer instead (see `_StubApi` pattern in Task 2's test).
- Make targeted fixes, commit, push, watch again. Cycle until green.

- [ ] **Step 4: Merge**

Once Mobile Build is green and the PR has Backend + Frontend SUCCESS:

```bash
gh pr merge --squash --delete-branch
```

(Same worktree-conflict caveat from previous PRs: `--delete-branch` may fail locally because master is in use by another worktree. Follow up with `git push origin --delete zhaochy/mobile-pull-to-refresh`.)

---

## Self-review checklist (run before handoff to executor)

- ✅ Each spec section maps to a task:
  - Goal → Tasks 1–6 + 7
  - Architecture (`StrideRefreshable`, `SyncController`) → Tasks 1 and 2
  - Per-screen integration table → Tasks 3, 4, 5, 6
  - UX details (icon visuals, SnackBar copy) → Task 3 step 2(c), Task 6 step 1
  - Error & edge cases → embedded in `SyncController` impl (Task 2 step 4) and CI failure-mode notes (Task 7 step 3)
  - Testing → Tasks 1, 2 (full); Tasks 3, 4 (minimal additions); Tasks 5, 6 (no new test files — relies on Task 7 CI green)

- ✅ No placeholders. All "verify type via grep" steps name the exact provider files. The one residual is the data-type column in Task 6 step 2 — Step 2 prescribes the grep that resolves it before writing the code, which is the same pattern as "verify before edit" elsewhere.

- ✅ Type consistency. `StrideRefreshable<T>` uses `Refreshable<Future<T>>` in both definition (Task 1) and callers (Tasks 3-6). `SyncController` extends `Notifier<SyncState>` consistently. `SyncIconButton` is the canonical widget name across Tasks 3, 4, 6.

- ✅ Self-contained tasks. Tasks 1, 2 produce reusable artifacts before any screen wiring. Tasks 3, 4 reference Task 1/2 outputs only. Tasks 5, 6 only reference Task 1 (refresh) and, for Task 6, the shared `SyncIconButton` it extracts.
