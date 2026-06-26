/// StatusRingCard — three circular progress rings for fatigue / TSB /
/// load ratio, shown on the D5 home screen.
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../../core/theme/app_typography.dart';
import '../../../core/theme/pill_colors.dart';
import '../../../core/theme/tokens.dart';
import '../../_shared/widgets/pill.dart';
import '../models/home_data.dart';

class StatusRingCard extends StatelessWidget {
  const StatusRingCard({super.key, required this.ring});

  final StatusRing ring;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        border: Border.all(color: StrideTokens.border2),
        borderRadius: BorderRadius.circular(StrideTokens.radiusLg),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceEvenly,
        children: [
          // STRIDE form (chronic − acute).
          _RingItem(
            label: 'TSB',
            value: ring.tsb.toStringAsFixed(1),
            fraction: _tsbFraction(ring.tsb),
            color: _tsbColor(ring.tsbBand),
            pillText: _tsbBandLabel(ring.tsbBand),
            pillVariant: _tsbPillVariant(ring.tsbBand),
          ),
          // STRIDE chronic load (CTL).
          if (ring.chronicLoad != null)
            _RingItem(
              label: '长期负荷',
              value: ring.chronicLoad!.toStringAsFixed(0),
              fraction: (ring.chronicLoad! / 100).clamp(0.0, 1.0),
              color: StrideTokens.accent,
              pillText: 'CTL',
              pillVariant: PillVariant.muted,
            ),
          // STRIDE acute/chronic ratio.
          _RingItem(
            label: '负荷比',
            value: ring.loadRatio.toStringAsFixed(2),
            fraction: (ring.loadRatio / 1.5).clamp(0.0, 1.0),
            color: _tsbColor(ring.tsbBand),
            pillText: _tsbBandLabel(ring.tsbBand),
            pillVariant: _tsbPillVariant(ring.tsbBand),
          ),
        ],
      ),
    );
  }

  // ── helpers ──

  double _tsbFraction(double tsb) {
    // Map tsb range [-40, +30] → [0, 1]
    return ((tsb + 40) / 70).clamp(0.0, 1.0);
  }

  Color _tsbColor(String band) {
    switch (band) {
      case 'race_ready':
        return StrideTokens.accent;
      case 'productive':
        return StrideTokens.accent;
      case 'overload':
        return StrideTokens.danger;
      case 'detraining':
        return StrideTokens.warn;
      default:
        return StrideTokens.muted2;
    }
  }

  String _tsbBandLabel(String band) {
    switch (band) {
      case 'race_ready':
        return '比赛就绪';
      case 'transitional':
        return '过渡区';
      case 'productive':
        return '训练中';
      case 'overload':
        return '过载';
      case 'detraining':
        return '去训练';
      default:
        return band;
    }
  }

  PillVariant _tsbPillVariant(String band) {
    switch (band) {
      case 'race_ready':
      case 'productive':
        return PillVariant.green;
      case 'overload':
        return PillVariant.danger;
      case 'detraining':
        return PillVariant.warn;
      default:
        return PillVariant.muted;
    }
  }

}

class _RingItem extends StatelessWidget {
  const _RingItem({
    required this.label,
    required this.value,
    required this.fraction,
    required this.color,
    required this.pillText,
    required this.pillVariant,
  });

  final String label;
  final String value;
  final double fraction;
  final Color color;
  final String pillText;
  final PillVariant pillVariant;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        SizedBox(
          width: 72,
          height: 72,
          child: Stack(
            alignment: Alignment.center,
            children: [
              CustomPaint(
                size: const Size(72, 72),
                painter: _RingPainter(
                  fraction: fraction,
                  color: color,
                  bgColor: StrideTokens.grid,
                  strokeWidth: 6,
                ),
              ),
              Text(
                value,
                style: const TextStyle(
                  fontFamily: AppTypography.fontMono,
                  fontSize: StrideTokens.fs14,
                  fontWeight: FontWeight.w700,
                  color: StrideTokens.fg,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: StrideTokens.spaceSm),
        Text(
          label,
          style: const TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs12,
            color: StrideTokens.muted,
          ),
        ),
        const SizedBox(height: StrideTokens.spaceXs),
        StridePill(text: pillText, variant: pillVariant, dense: true),
      ],
    );
  }
}

class _RingPainter extends CustomPainter {
  const _RingPainter({
    required this.fraction,
    required this.color,
    required this.bgColor,
    required this.strokeWidth,
  });

  final double fraction;
  final Color color;
  final Color bgColor;
  final double strokeWidth;

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final radius = (size.width - strokeWidth) / 2;
    final rect = Rect.fromCircle(center: center, radius: radius);

    final bgPaint = Paint()
      ..color = bgColor
      ..style = PaintingStyle.stroke
      ..strokeWidth = strokeWidth
      ..strokeCap = StrokeCap.round;

    final fgPaint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = strokeWidth
      ..strokeCap = StrokeCap.round;

    // Background full circle
    canvas.drawArc(rect, -math.pi / 2, 2 * math.pi, false, bgPaint);

    // Foreground arc
    if (fraction > 0) {
      canvas.drawArc(
        rect,
        -math.pi / 2,
        2 * math.pi * fraction,
        false,
        fgPaint,
      );
    }
  }

  @override
  bool shouldRepaint(_RingPainter old) =>
      old.fraction != fraction || old.color != color;
}
