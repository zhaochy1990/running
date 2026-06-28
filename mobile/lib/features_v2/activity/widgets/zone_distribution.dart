/// ZoneDistribution — compact HR / pace zone bars.
///
/// Flutter port of `frontend/src/components/ZoneChart.tsx`: same labels,
/// colors, range formatting, and duration formatting. Expects [zones] already
/// filtered by type, normalized (pace 7→6), and sorted ascending.
library;

import 'package:flutter/material.dart';

import '../../../core/theme/app_typography.dart';
import '../../../core/theme/tokens.dart';
import '../models/activity_detail.dart';

const List<String> kZoneLabels = [
  'Z1 积极恢复区',
  'Z2 有氧耐力区',
  'Z3 有氧动力区',
  'Z4 乳酸阈区',
  'Z5 速度耐力区',
  'Z6 无氧动力区',
];

const List<Color> kZoneColors = [
  Color(0xFF00C853),
  Color(0xFF64DD17),
  Color(0xFFFFAB00),
  Color(0xFFFF6D00),
  Color(0xFFFF1744),
  Color(0xFFC2185B),
];

enum ZoneKind { hr, pace }

class ZoneDistribution extends StatelessWidget {
  const ZoneDistribution({
    super.key,
    required this.zones,
    required this.type,
  });

  /// Already normalized + sorted zones for this [type].
  final List<ZoneV2> zones;
  final ZoneKind type;

  @override
  Widget build(BuildContext context) {
    final display = zones
        .where((z) => z.zoneIndex >= 1 && z.zoneIndex <= kZoneLabels.length)
        .toList(growable: false);

    if (display.isEmpty) return const SizedBox.shrink();

    var maxPercent = 1.0;
    for (final z in display) {
      if (z.percent > maxPercent) maxPercent = z.percent.toDouble();
    }

    return Column(
      children: [
        for (var i = 0; i < display.length; i++)
          _ZoneRow(
            zone: display[i],
            color: i < kZoneColors.length
                ? kZoneColors[i]
                : StrideTokens.muted,
            label: i < kZoneLabels.length
                ? kZoneLabels[i]
                : 'Z${display[i].zoneIndex}',
            range: type == ZoneKind.hr
                ? _formatHrRange(display[i], display)
                : _formatPaceRange(display[i], display),
            unit: type == ZoneKind.hr ? ' bpm' : '/km',
            widthFraction:
                (display[i].percent / maxPercent).clamp(0.02, 1.0).toDouble(),
          ),
      ],
    );
  }
}

class _ZoneRow extends StatelessWidget {
  const _ZoneRow({
    required this.zone,
    required this.color,
    required this.label,
    required this.range,
    required this.unit,
    required this.widthFraction,
  });

  final ZoneV2 zone;
  final Color color;
  final String label;
  final String range;
  final String unit;
  final double widthFraction;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          // LEFT: Z{n} {name} (range unit)
          SizedBox(
            width: 132,
            child: RichText(
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              text: TextSpan(
                children: [
                  TextSpan(
                    text: label,
                    style: const TextStyle(
                      fontFamily: AppTypography.fontMono,
                      fontSize: StrideTokens.fs10,
                      color: StrideTokens.fg,
                    ),
                  ),
                  if (range.isNotEmpty)
                    TextSpan(
                      text: '  ($range$unit)',
                      style: const TextStyle(
                        fontFamily: AppTypography.fontMono,
                        fontSize: 9,
                        color: StrideTokens.muted2,
                      ),
                    ),
                ],
              ),
            ),
          ),
          const SizedBox(width: StrideTokens.spaceSm),
          // MIDDLE: track + dot + proportional fill
          Expanded(
            child: SizedBox(
              height: 6,
              child: Stack(
                children: [
                  // track
                  Container(
                    decoration: BoxDecoration(
                      color: StrideTokens.grid,
                      borderRadius: BorderRadius.circular(StrideTokens.radiusPill),
                    ),
                  ),
                  // proportional fill
                  FractionallySizedBox(
                    widthFactor: widthFraction,
                    child: Container(
                      decoration: BoxDecoration(
                        color: color.withValues(alpha: 0.85),
                        borderRadius:
                            BorderRadius.circular(StrideTokens.radiusPill),
                      ),
                    ),
                  ),
                  // start dot
                  Align(
                    alignment: Alignment.centerLeft,
                    child: Container(
                      width: 6,
                      height: 6,
                      decoration: BoxDecoration(
                        color: color,
                        shape: BoxShape.circle,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(width: StrideTokens.spaceSm),
          // RIGHT: duration + percent
          SizedBox(
            width: 72,
            child: Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                Text(
                  _formatDuration(zone.durationS.round()),
                  style: const TextStyle(
                    fontFamily: AppTypography.fontMono,
                    fontSize: StrideTokens.fs10,
                    color: StrideTokens.muted,
                  ),
                ),
                const SizedBox(width: StrideTokens.spaceXs),
                Text(
                  '${zone.percent.toStringAsFixed(1)}%',
                  style: TextStyle(
                    fontFamily: AppTypography.fontMono,
                    fontSize: StrideTokens.fs11,
                    fontWeight: FontWeight.w700,
                    color: color,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ── Formatting (ported from ZoneChart.tsx) ──────────────────────────────────

String _formatDuration(int seconds) {
  final m = seconds ~/ 60;
  final s = seconds % 60;
  if (m >= 60) {
    final h = m ~/ 60;
    final rm = m % 60;
    return '${h}h${rm}m';
  }
  return s > 0 ? '${m}m${s}s' : '${m}m';
}

int _maxZoneIndex(List<ZoneV2> zones) {
  var maxIdx = 0;
  for (final z in zones) {
    if (z.zoneIndex > maxIdx) maxIdx = z.zoneIndex;
  }
  return maxIdx;
}

String _formatHrRange(ZoneV2 zone, List<ZoneV2> zones) {
  final rMin = zone.rangeMin;
  final rMax = zone.rangeMax;
  if (rMin == null || rMax == null) return '';
  final min = rMin.round();
  final max = rMax.round();
  final maxIdx = _maxZoneIndex(zones);
  if (zone.zoneIndex == 1) {
    final z2 = zones.where((z) => z.zoneIndex == 2).firstOrNull;
    if (z2?.rangeMin != null && z2!.rangeMin!.round() == min) {
      return '< $min';
    }
  }
  if (zone.zoneIndex == maxIdx) return '≥ $min';
  return '$min–$max';
}

String _toPace(num msPerKm) {
  final s = (msPerKm / 1000).round();
  return '${s ~/ 60}:${(s % 60).toString().padLeft(2, '0')}';
}

String _formatPaceRange(ZoneV2 zone, List<ZoneV2> zones) {
  final rMin = zone.rangeMin;
  final rMax = zone.rangeMax;
  if (rMin == null || rMax == null) return '';
  final minPace = _toPace(rMin);
  final maxPace = _toPace(rMax);
  final maxIdx = _maxZoneIndex(zones);
  if (zone.zoneIndex == 1) {
    final z2 = zones.where((z) => z.zoneIndex == 2).firstOrNull;
    if (z2?.rangeMin != null && z2!.rangeMin!.round() == rMin.round()) {
      return '> $maxPace';
    }
  }
  if (zone.zoneIndex == maxIdx) return '< $minPace';
  return '$minPace–$maxPace';
}
