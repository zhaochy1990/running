// StrideRefreshable<T> — single-purpose RefreshIndicator wrapper.
//
// Pull-to-refresh triggers `ref.refresh(provider)` (Riverpod's
// invalidate-and-return-new-future combinator), keeping the spinner
// active until the awaited future resolves.  Provider-side errors are
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
          // ref.refresh is annotated @useResult; we intentionally only
          // await for completion (the resolved value belongs to the
          // watching screen).  ignore the lint locally.
          // ignore: unused_result
          await ref.refresh(provider);
        } catch (_) {
          // Screen owns its own error UI via AsyncValue.when(error:).
        }
      },
      child: child,
    );
  }
}
