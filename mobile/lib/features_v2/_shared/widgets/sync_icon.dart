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
