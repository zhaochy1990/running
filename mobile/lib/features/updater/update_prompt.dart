import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:open_filex/open_filex.dart';

import '../../core/theme/app_colors.dart';
import '../../core/theme/app_typography.dart';
import '../../core/updater/update_checker.dart';
import '../../core/updater/update_info.dart';

/// Shows the update prompt as a modal bottom sheet. Returns once the user
/// dismisses or completes the install hand-off; never throws.
Future<void> showUpdatePrompt(
  BuildContext context,
  WidgetRef ref,
  UpdateInfo info,
) async {
  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AppColors.surface,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (_) => _UpdateSheet(info: info),
  );
}

class _UpdateSheet extends ConsumerStatefulWidget {
  const _UpdateSheet({required this.info});
  final UpdateInfo info;

  @override
  ConsumerState<_UpdateSheet> createState() => _UpdateSheetState();
}

class _UpdateSheetState extends ConsumerState<_UpdateSheet> {
  double? _progress;
  String? _error;

  Future<void> _download() async {
    setState(() {
      _progress = 0;
      _error = null;
    });
    try {
      final apkPath = await ref
          .read(updateCheckerProvider)
          .downloadApk(widget.info, onProgress: (p) {
        if (!mounted) return;
        setState(() => _progress = p);
      });
      // Hand the APK to the system installer. The user gets the standard
      // "Install" prompt; if they haven't granted REQUEST_INSTALL_PACKAGES
      // for STRIDE yet, the system itself will route them to settings.
      final result = await OpenFilex.open(apkPath);
      if (!mounted) return;
      if (result.type != ResultType.done) {
        setState(() {
          _error = '无法打开安装器：${result.message}';
          _progress = null;
        });
        return;
      }
      // Close the sheet — the system installer is now in the foreground.
      Navigator.of(context).pop();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '下载失败：$e';
        _progress = null;
      });
    }
  }

  Future<void> _later() async {
    await ref.read(updateCheckerProvider).dismiss(widget.info.versionName);
    if (!mounted) return;
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final sizeMb = (widget.info.apkSize / 1024 / 1024).toStringAsFixed(1);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Center(
              child: Container(
                width: 40,
                height: 4,
                decoration: BoxDecoration(
                  color: AppColors.gray300,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            const SizedBox(height: 16),
            Row(
              children: [
                const Icon(
                  Icons.system_update_alt,
                  size: 24,
                  color: AppColors.accentDark,
                ),
                const SizedBox(width: 12),
                Text('发现新版本', style: theme.textTheme.titleLarge),
              ],
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Text(widget.info.versionName, style: AppTypography.monoTitle),
                const SizedBox(width: 8),
                Text('· $sizeMb MB',
                    style: AppTypography.monoCaption.copyWith(
                      color: AppColors.foregroundMuted,
                    )),
              ],
            ),
            if (widget.info.releaseNotes != null &&
                widget.info.releaseNotes!.trim().isNotEmpty) ...[
              const SizedBox(height: 12),
              Container(
                constraints: const BoxConstraints(maxHeight: 220),
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: AppColors.surfaceMuted,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: SingleChildScrollView(
                  child: Text(
                    widget.info.releaseNotes!,
                    style: AppTypography.monoCaption,
                  ),
                ),
              ),
            ],
            if (_progress != null) ...[
              const SizedBox(height: 16),
              LinearProgressIndicator(value: _progress),
              const SizedBox(height: 4),
              Text(
                '${(_progress! * 100).toStringAsFixed(0)}%',
                style: AppTypography.monoCaption,
              ),
            ],
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(_error!,
                  style: theme.textTheme.bodySmall
                      ?.copyWith(color: AppColors.danger)),
            ],
            const SizedBox(height: 20),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: _progress != null ? null : _later,
                    child: const Text('稍后'),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: FilledButton(
                    onPressed: _progress != null ? null : _download,
                    child: const Text('立即更新'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
