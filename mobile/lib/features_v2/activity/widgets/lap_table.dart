/// LapTable — 圈速表（对齐小程序 buildLapRows）。
///
/// 每行：圈号（恢复圈不占号，显示「恢复」）/距离/时长/配速+走向箭头/HR+走向/
/// 步频；全场最快/最慢行高亮并打标（有配速的圈 ≥3 才标，按 avg_pace 排）。
library;

import 'package:flutter/material.dart';

import '../../../core/theme/app_typography.dart';
import '../../../core/theme/tokens.dart';
import '../models/activity_detail.dart';
import '../utils/lap_marks.dart';

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

    final marks = lapMarks(laps);
    var lapNo = 0;

    return Column(
      children: [
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
        for (var i = 0; i < laps.length; i++) ...[
          _LapRow(
            index: marks[i].rest ? '恢复' : '${++lapNo}',
            distance: '${laps[i].distanceKm.toStringAsFixed(2)} km',
            duration: laps[i].durationFmt,
            pace: laps[i].paceFmt,
            hr: laps[i].avgHr != null ? '${laps[i].avgHr}' : '--',
            cadence: laps[i].avgCadence != null ? '${laps[i].avgCadence}' : '--',
            paceTrend: marks[i].trend,
            hrTrend: marks[i].hrTrend,
            fastest: marks[i].fastest,
            slowest: marks[i].slowest,
            rest: marks[i].rest,
          ),
          const Divider(height: 1, color: StrideTokens.border2),
        ],
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
    this.paceTrend = Trend.none,
    this.hrTrend = Trend.none,
    this.fastest = false,
    this.slowest = false,
    this.rest = false,
  });

  final String index;
  final String distance;
  final String duration;
  final String pace;
  final String hr;
  final String cadence;
  final bool isHeader;
  final Trend paceTrend;
  final Trend hrTrend;
  final bool fastest;
  final bool slowest;
  final bool rest;

  @override
  Widget build(BuildContext context) {
    final baseStyle = isHeader
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

    final highlight = fastest
        ? const Color(0xFF37c85a)
        : slowest
            ? const Color(0xFFef4444)
            : null;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: StrideTokens.spaceSm),
      child: Row(
        children: [
          SizedBox(
            width: 36,
            child: Row(
              children: [
                Flexible(
                  child: Text(
                    index,
                    overflow: TextOverflow.ellipsis,
                    style: rest
                        ? baseStyle.copyWith(color: StrideTokens.muted)
                        : fastest || slowest
                            ? baseStyle.copyWith(
                                fontWeight: FontWeight.w700, color: highlight)
                            : baseStyle,
                  ),
                ),
                if (fastest || slowest) ...[
                  const SizedBox(width: 2),
                  Text(
                    fastest ? '最快' : '最慢',
                    style: TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: 9,
                      fontWeight: FontWeight.w700,
                      color: highlight,
                    ),
                  ),
                ],
              ],
            ),
          ),
          Expanded(flex: 3, child: Text(distance, style: baseStyle)),
          Expanded(flex: 2, child: Text(duration, style: baseStyle)),
          Expanded(
            flex: 2,
            child: Row(
              children: [
                Flexible(
                  child: Text(pace, style: baseStyle, overflow: TextOverflow.ellipsis),
                ),
                if (!isHeader) _TrendArrow(trend: paceTrend, fasterIsUp: true),
              ],
            ),
          ),
          SizedBox(
            width: 40,
            child: Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                Text(hr, style: baseStyle, textAlign: TextAlign.end),
                if (!isHeader) _TrendArrow(trend: hrTrend, fasterIsUp: false),
              ],
            ),
          ),
          SizedBox(
            width: 44,
            child: Text(cadence, style: baseStyle, textAlign: TextAlign.end),
          ),
        ],
      ),
    );
  }
}

/// 走向小箭头：配速 up=变快（▲ 绿）；心率 up=升高（▲ 红）。
class _TrendArrow extends StatelessWidget {
  const _TrendArrow({required this.trend, required this.fasterIsUp});

  final Trend trend;
  final bool fasterIsUp;

  @override
  Widget build(BuildContext context) {
    if (trend == Trend.none) return const SizedBox.shrink();
    final up = trend == Trend.up;
    final color = fasterIsUp
        ? (up ? const Color(0xFF37c85a) : const Color(0xFFef4444))
        : (up ? const Color(0xFFef4444) : const Color(0xFF37c85a));
    return Icon(
      up ? Icons.arrow_drop_up : Icons.arrow_drop_down,
      size: 14,
      color: color,
    );
  }
}
