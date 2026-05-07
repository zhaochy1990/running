import 'package:flutter/material.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_typography.dart';
import '../../../data/models/activity.dart';
import '../../../shared/utils/format.dart';

/// Stacked horizontal bar showing HR zone breakdown (Z1-Z5) with
/// per-zone duration % below.
class ZonesBar extends StatelessWidget {
  const ZonesBar({required this.zones, super.key});

  final List<Zone> zones;

  @override
  Widget build(BuildContext context) {
    if (zones.isEmpty) return const SizedBox.shrink();

    final total = zones.fold<num>(0, (sum, z) => sum + z.durationS);
    if (total <= 0) return const SizedBox.shrink();

    final sorted = List<Zone>.from(zones)
      ..sort((a, b) => a.zoneIndex.compareTo(b.zoneIndex));

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(4),
          child: SizedBox(
            height: 16,
            child: Row(
              children: [
                for (final z in sorted)
                  if (z.durationS > 0)
                    Expanded(
                      flex: ((z.durationS / total) * 1000).round(),
                      child: Container(color: _zoneColor(z.zoneIndex)),
                    ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 12,
          runSpacing: 4,
          children: [
            for (final z in sorted)
              if (z.durationS > 0)
                _ZoneChip(
                  index: z.zoneIndex,
                  percent: z.percent.toDouble(),
                  duration: durationFmt(z.durationS.toInt()),
                ),
          ],
        ),
      ],
    );
  }

  static Color _zoneColor(int index) {
    switch (index) {
      case 1:
        return AppColors.zoneZ1;
      case 2:
        return AppColors.zoneZ2;
      case 3:
        return AppColors.zoneZ3;
      case 4:
        return AppColors.zoneZ4;
      case 5:
        return AppColors.zoneZ5;
      default:
        return AppColors.gray400;
    }
  }
}

class _ZoneChip extends StatelessWidget {
  const _ZoneChip({
    required this.index,
    required this.percent,
    required this.duration,
  });

  final int index;
  final double percent;
  final String duration;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 8,
          height: 8,
          decoration: BoxDecoration(
            color: ZonesBar._zoneColor(index),
            borderRadius: BorderRadius.circular(2),
          ),
        ),
        const SizedBox(width: 4),
        Text(
          'Z$index ${percent.toStringAsFixed(0)}%',
          style: AppTypography.monoCaption,
        ),
        const SizedBox(width: 4),
        Text(
          duration,
          style: AppTypography.monoCaption.copyWith(
            color: AppColors.foregroundSubtle,
          ),
        ),
      ],
    );
  }
}
