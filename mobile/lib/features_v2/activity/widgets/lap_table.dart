/// LapTable — simplified laps list for the v2 activity detail screen.
///
/// Each row shows: lap index / distance / duration / pace / avg HR / cadence.
library;

import 'package:flutter/material.dart';

import '../../../core/theme/app_typography.dart';
import '../../../core/theme/tokens.dart';
import '../models/activity_detail.dart';

class LapTable extends StatelessWidget {
  const LapTable({super.key, required this.laps});

  final List<LapV2> laps;

  @override
  Widget build(BuildContext context) {
    if (laps.isEmpty) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: StrideTokens.spaceXl),
        child: Center(
          child: Text(
            '暂无分段数据',
            style: TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs13,
              color: StrideTokens.muted,
            ),
          ),
        ),
      );
    }

    return Column(
      children: [
        // Header
        const _LapRow(
          index: '圈',
          distance: '距离',
          duration: '时长',
          pace: '配速',
          hr: 'HR',
          cadence: '步频',
          isHeader: true,
        ),
        const Divider(height: 1, color: StrideTokens.border2),
        ...laps.map((lap) => Column(
              children: [
                _LapRow(
                  index: '${lap.lapIndex + 1}',
                  distance: '${lap.distanceKm.toStringAsFixed(2)} km',
                  duration: lap.durationFmt,
                  pace: lap.paceFmt,
                  hr: lap.avgHr != null ? '${lap.avgHr}' : '--',
                  cadence: lap.avgCadence != null ? '${lap.avgCadence}' : '--',
                ),
                const Divider(height: 1, color: StrideTokens.border2),
              ],
            )),
      ],
    );
  }
}

class _LapRow extends StatelessWidget {
  const _LapRow({
    required this.index,
    required this.distance,
    required this.duration,
    required this.pace,
    required this.hr,
    required this.cadence,
    this.isHeader = false,
  });

  final String index;
  final String distance;
  final String duration;
  final String pace;
  final String hr;
  final String cadence;
  final bool isHeader;

  @override
  Widget build(BuildContext context) {
    final style = isHeader
        ? const TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs11,
            fontWeight: FontWeight.w600,
            color: StrideTokens.muted,
          )
        : const TextStyle(
            fontFamily: AppTypography.fontMono,
            fontSize: StrideTokens.fs12,
            color: StrideTokens.fgSoft,
          );

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: StrideTokens.spaceSm),
      child: Row(
        children: [
          SizedBox(width: 24, child: Text(index, style: style)),
          Expanded(flex: 3, child: Text(distance, style: style)),
          Expanded(flex: 2, child: Text(duration, style: style)),
          Expanded(flex: 2, child: Text(pace, style: style)),
          SizedBox(
            width: 40,
            child: Text(hr, style: style, textAlign: TextAlign.end),
          ),
          SizedBox(
            width: 44,
            child: Text(cadence, style: style, textAlign: TextAlign.end),
          ),
        ],
      ),
    );
  }
}
