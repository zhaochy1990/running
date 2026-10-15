/// 训练状态页（#465）—— 复刻小程序 training-status 一页到底：
/// 4 指标卡 / 窗口 toggle / RHR+HRV 折线 / 负荷 6 指标 / readiness 门控 /
/// Dose 柱 / 慢性 vs 急性双线 / Form 柱五档 / 8 周周剂量 / 16 周热力图 /
/// STRIDE 区间两表 / footer / 页尾三 tile（E4 能力雷达 · E5 预测 · E6 PB）。
///
/// 口径：form/CTL 相对五档；ACWR 只作负荷指标之一；readiness 用后端
/// green/yellow/red + reasons 中文映射。绝对 TSB 口径随 E2 删除而废弃。
library;

import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/router/routes.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../../data/models/activity.dart';
import '../../data/models/training_status.dart';
import '../../shared/utils/format.dart';
import '../_shared/widgets/refreshable.dart';
import '../_shared/widgets/seg_control.dart';
import '../_shared/widgets/section_header.dart';
import '../_shared/widgets/top_bar.dart';
import 'providers/training_status_provider.dart';
import 'utils/training_status_logic.dart';
import 'widgets/metric_card.dart';

const _rhrColor = Color(0xFF0097A7);
const _hrvColor = Color(0xFF7A4DD4);
const _doseColor = Color(0xFFE68A00);
const _chronicColor = Color(0xFF00A85A);
const _acuteColor = Color(0xFF0097A7);

/// uCharts tooltip 深色盒对照（#423 决议：tooltip 深色盒 #101111）。
const _tooltipBg = Color(0xFF101111);
const _tooltipFg = Color(0xFFE3E2E5);

const _windowOptions = [14, 30, 60, 90];

class TrainingStatusScreen extends ConsumerStatefulWidget {
  const TrainingStatusScreen({super.key});

  @override
  ConsumerState<TrainingStatusScreen> createState() =>
      _TrainingStatusScreenState();
}

class _TrainingStatusScreenState extends ConsumerState<TrainingStatusScreen> {
  int _trendDays = 30;
  String? _heatSelected; // 上海 YYYY-MM-DD

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(trainingStatusProvider);

    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: StrideTopBar(title: '训练状态'),
      body: async.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(
          child: Padding(
            padding: const EdgeInsets.all(StrideTokens.space2xl),
            child: Text(
              '加载失败\n$e',
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs13,
                color: StrideTokens.muted,
              ),
            ),
          ),
        ),
        data: (data) => StrideRefreshable(
          provider: trainingStatusProvider.future,
          child: ListView(
            padding: const EdgeInsets.all(StrideTokens.spaceLg),
            children: _sections(data),
          ),
        ),
      ),
    );
  }

  // ── 分区组装 ───────────────────────────────────────────────────────────────

  List<Widget> _sections(TrainingStatusData data) {
    final cur = data.load.current;
    final children = <Widget>[
      const WfSectionHeader('核心指标'),
      _MetricGrid(data: data),
      const SizedBox(height: StrideTokens.spaceXl),
      _sectionHeaderWithToggle('趋势'),
      _chartCard(label: '静息心率 · 手表读数', child: _rhrChart(data)),
      const SizedBox(height: StrideTokens.spaceMd),
      _chartCard(label: '心率变异性 · 手表读数', child: _hrvChart(data)),
    ];

    if (cur != null) {
      children.addAll([
        const SizedBox(height: StrideTokens.spaceXl),
        const WfSectionHeader('训练负荷'),
        _LoadSummaryCard(cur: cur),
        const SizedBox(height: StrideTokens.spaceMd),
        _chartCard(label: '每日训练负荷（Dose）', child: _doseChart(data)),
        const SizedBox(height: StrideTokens.spaceMd),
        _chartCard(
          label: '慢性负荷（42日 EWMA） vs 急性负荷（7日 EWMA）',
          child: _loadChart(data),
        ),
        const SizedBox(height: StrideTokens.spaceMd),
        _chartCard(
          label: '竞技状态 Form（慢性负荷 − 急性负荷）',
          child: _formChart(data),
          afterChart: _formLegendAndNote(cur),
        ),
        const SizedBox(height: StrideTokens.spaceMd),
        _chartCard(label: '8 周负荷趋势', child: _weekChart(data)),
        const SizedBox(height: StrideTokens.spaceMd),
        _HeatmapCard(
          data: data,
          selected: _heatSelected,
          onCellTap: (date) =>
              setState(() => _heatSelected = _heatSelected == date ? null : date),
        ),
      ]);
    }

    if (data.zones.hasZones) {
      children.addAll([
        const SizedBox(height: StrideTokens.spaceXl),
        const WfSectionHeader('STRIDE 区间'),
        _ZoneTableCard(
          label: '配速区间',
          rows: data.zones.paceZones
              .map((z) => _ZoneRow(
                    name: z.name,
                    label: z.label,
                    range: _paceRange(z.upperPace, z.lowerPace),
                    nameColor: _rhrColor,
                  ))
              .toList(),
        ),
        const SizedBox(height: StrideTokens.spaceMd),
        _ZoneTableCard(
          label: '心率区间',
          rows: data.zones.hrZones
              .map((z) => _ZoneRow(
                    name: z.name,
                    label: z.label,
                    range: _bpmRange(z.lowerBpm, z.upperBpm),
                    nameColor: const Color(0xFFD97706),
                  ))
              .toList(),
        ),
      ]);
    }

    children.addAll([
      const SizedBox(height: StrideTokens.spaceXl),
      _FooterLines(data: data),
      const SizedBox(height: StrideTokens.spaceXl),
      const _DomainTiles(),
      const SizedBox(height: StrideTokens.spaceXl),
    ]);
    return children;
  }

  Widget _sectionHeaderWithToggle(String title) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        children: [
          Expanded(
            child: Text(
              title.toUpperCase(),
              style: const TextStyle(
                fontFamily: AppTypography.fontMono,
                fontSize: 9,
                fontWeight: FontWeight.w700,
                letterSpacing: 1.44,
                color: StrideTokens.muted,
              ),
            ),
          ),
          SizedBox(
            width: 160,
            child: StrideSegControl(
              options: [for (final d in _windowOptions) '${d}d'],
              selectedIndex: _windowOptions.indexOf(_trendDays),
              onChanged: (i) => setState(() => _trendDays = _windowOptions[i]),
            ),
          ),
        ],
      ),
    );
  }

  Widget _chartCard({
    required String label,
    required Widget child,
    Widget? afterChart,
  }) {
    return Container(
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: const TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs12,
              color: StrideTokens.muted,
            ),
          ),
          const SizedBox(height: StrideTokens.spaceMd),
          child,
          if (afterChart != null) afterChart,
        ],
      ),
    );
  }

  // ── 趋势数据切片（窗口天数，oldest → newest）────────────────────────────

  List<({String label, double? y})> _rhrSeries(
    TrainingStatusData data,
    int days,
  ) {
    final rows = data.health.health
        .where((r) => r.rhr != null)
        .toList()
        .reversed
        .toList();
    final tail = rows.length > days ? rows.sublist(rows.length - days) : rows;
    return [
      for (final r in tail) (label: formatDateShort(r.date), y: r.rhr!.toDouble()),
    ];
  }

  List<({String label, double? y})> _hrvSeries(
    TrainingStatusData data,
    int days,
  ) {
    final rows = data.hrv.hrv.where((r) => r.lastNightAvg != null).toList();
    final tail = rows.length > days ? rows.sublist(rows.length - days) : rows;
    return [
      for (final r in tail)
        (label: formatDateShort(r.date), y: r.lastNightAvg!.toDouble()),
    ];
  }

  Widget _rhrChart(TrainingStatusData data) {
    final s = _rhrSeries(data, _trendDays);
    final base = data.health.rhrBaseline?.toDouble();
    final ys = [
      for (final p in s) p.y,
      if (base != null) base,
    ].nonNull;
    if (s.length < 2) return _chartEmpty('暂无 RHR 数据');
    return _lineChart(
      points: s,
      minY: _padMin(ys),
      maxY: _padMax(ys),
      tooltip: (p) => '${p.label} · RHR ${p.y!.round()} bpm',
    );
  }

  Widget _hrvChart(TrainingStatusData data) {
    final s = _hrvSeries(data, _trendDays);
    if (s.length < 2) return _chartEmpty('暂无 HRV 数据');
    final low = data.health.hrv.hrvNormalLow?.toDouble();
    final high = data.health.hrv.hrvNormalHigh?.toDouble();
    final ys = [
      for (final p in s) p.y,
      if (low != null) low,
      if (high != null) high,
    ].nonNull;
    return _lineChart(
      points: s,
      minY: _padMin(ys),
      maxY: _padMax(ys),
      tooltip: (p) => '${p.label} · HRV ${p.y!.round()} ms',
    );
  }

  List<({String label, double? y})> _doseSeries(
    TrainingStatusData data,
    int days,
  ) {
    final rows = data.load.series;
    final tail = rows.length > days ? rows.sublist(rows.length - days) : rows;
    return [
      for (final r in tail)
        (
          label: formatDateShort(r.date),
          y: r.isUnknown ? null : r.trainingDose,
        ),
    ];
  }

  Widget _doseChart(TrainingStatusData data) {
    final s = _doseSeries(data, _trendDays);
    if (!s.any((p) => p.y != null && p.y! > 0)) {
      return _chartEmpty('暂无训练负荷数据');
    }
    final maxV = s.fold<double>(0, (m, p) => p.y != null && p.y! > m ? p.y! : m);
    return _barChart(
      points: s,
      maxY: maxV * 1.1,
      defaultColor: _doseColor,
      tooltip: (p) =>
          '${p.label} · 训练负荷 ${p.y == null ? '数据未确认' : p.y!.round()}',
    );
  }

  Widget _loadChart(TrainingStatusData data) {
    final rows = data.load.series;
    final tail =
        rows.length > _trendDays ? rows.sublist(rows.length - _trendDays) : rows;
    final chronic = [
      for (final r in tail)
        (label: formatDateShort(r.date), y: r.isUnknown ? null : r.chronicLoad),
    ];
    final acute = [
      for (final r in tail)
        (label: formatDateShort(r.date), y: r.isUnknown ? null : r.acuteLoad),
    ];
    if (![...chronic, ...acute].any((p) => p.y != null)) {
      return _chartEmpty('暂无趋势数据');
    }
    final ys = [
      ...chronic.map((p) => p.y),
      ...acute.map((p) => p.y),
    ].nonNull;
    final span = ys.reduce((a, b) => a > b ? a : b) -
        ys.reduce((a, b) => a < b ? a : b);
    final pad = span > 0 ? span * 0.1 : 1.0;
    return _lineChart(
      points: chronic,
      secondLine: (
        points: acute,
        color: _acuteColor,
        name: '急性负荷',
      ),
      minY: ys.reduce((a, b) => a < b ? a : b) - pad,
      maxY: ys.reduce((a, b) => a > b ? a : b) + pad,
      tooltip: (p) => '${p.label} · 慢性负荷 ${p.y!.toStringAsFixed(1)}',
      secondTooltip: (p) => '${p.label} · 急性负荷 ${p.y!.toStringAsFixed(1)}',
    );
  }

  Widget _formChart(TrainingStatusData data) {
    final rows = data.load.series;
    final tail =
        rows.length > _trendDays ? rows.sublist(rows.length - _trendDays) : rows;
    final points = [
      for (final r in tail)
        (
          label: formatDateShort(r.date),
          y: r.isUnknown ? null : r.form,
          color: Color(formColor(r.form, r.chronicLoad)),
        ),
    ];
    if (!points.any((p) => p.y != null)) return _chartEmpty('暂无 Form 数据');
    final values = [for (final p in points) p.y].nonNull;
    final lo = values.reduce((a, b) => a < b ? a : b);
    final hi = values.reduce((a, b) => a > b ? a : b);
    return _formBarChart(
      points: points,
      minY: lo < 0 ? lo : 0,
      maxY: hi > 0 ? hi : 0,
      // Form tooltip 需要 chronic 求 zone → 从原始 series 查。
      chronicByLabel: {
        for (final r in tail) formatDateShort(r.date): r.chronicLoad,
      },
    );
  }

  Widget _weekChart(TrainingStatusData data) {
    final buckets = aggregateWeeklyDose(data.load.series);
    if (!buckets.any((b) => b.totalDose != null && b.totalDose! > 0)) {
      return _chartEmpty('暂无周剂量数据');
    }
    final points = [
      for (final b in buckets)
        (label: b.weekLabel, y: b.totalDose == null ? null : b.totalDose),
    ];
    final maxV = buckets.fold<double>(
      0,
      (m, b) => (b.totalDose ?? 0) > m ? b.totalDose! : m,
    );
    return _barChart(
      points: points,
      maxY: maxV * 1.1,
      defaultColor: _doseColor,
      tooltip: (p) {
        final b = buckets.firstWhere((b) => b.weekLabel == p.label);
        return '周一 ${b.weekLabel} · '
            '${p.y?.toStringAsFixed(1) ?? '数据不完整'}（${b.activeDays} 天）';
      },
    );
  }

  // ── 图表构建（fl_chart）──────────────────────────────────────────────────

  Widget _chartEmpty(String text) => SizedBox(
        height: 120,
        child: Center(
          child: Text(
            text,
            style: const TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs12,
              color: StrideTokens.muted2,
            ),
          ),
        ),
      );

  double _padMin(Iterable<double> ys) {
    final list = ys.toList();
    if (list.isEmpty) return 0;
    final minV = list.reduce((a, b) => a < b ? a : b);
    final maxV = list.reduce((a, b) => a > b ? a : b);
    final pad = maxV - minV == 0 ? 2 : 0;
    return minV - (pad == 0 ? 2 : pad);
  }

  double _padMax(Iterable<double> ys) {
    final list = ys.toList();
    if (list.isEmpty) return 1;
    final minV = list.reduce((a, b) => a < b ? a : b);
    final maxV = list.reduce((a, b) => a > b ? a : b);
    final pad = maxV - minV == 0 ? 2 : 0;
    return maxV + (pad == 0 ? 2 : pad);
  }

  /// 折线卡（uCharts line straight width2 对照）：x 为索引，null = 缺口。
  Widget _lineChart({
    required List<({String label, double? y})> points,
    required double minY,
    required double maxY,
    required String Function(({String label, double? y})) tooltip,
    ({List<({String label, double? y})> points, Color color, String name})?
        secondLine,
    String Function(({String label, double? y}))? secondTooltip,
  }) {
    final spots = [
      for (var i = 0; i < points.length; i++) _spot(i, points[i]),
    ];
    final xLabel = (int i) => points[i].label;
    final secondSpots = secondLine == null
        ? <FlSpot>[]
        : [for (var i = 0; i < secondLine.points.length; i++) _spot(i, secondLine.points[i])];

    return SizedBox(
      height: 160,
      child: LineChart(
        LineChartData(
          minX: 0,
          maxX: points.length <= 1 ? 1 : (points.length - 1).toDouble(),
          minY: minY,
          maxY: maxY,
          clipData: const FlClipData.all(),
          gridData: FlGridData(
            show: true,
            drawVerticalLine: false,
            horizontalInterval: (maxY - minY) / 4,
            getDrawingHorizontalLine: (_) =>
                const FlLine(color: StrideTokens.grid, strokeWidth: 1),
          ),
          borderData: FlBorderData(show: false),
          titlesData: _titles(points.length, xLabel),
          lineTouchData: LineTouchData(
            touchTooltipData: LineTouchTooltipData(
              getTooltipColor: (_) => _tooltipBg,
              fitInsideHorizontally: true,
              fitInsideVertically: true,
              getTooltipItems: (touched) => [
                for (final s in touched)
                  if (s.x.isNaN || s.y.isNaN)
                    null
                  else if (s.barIndex == 0)
                    LineTooltipItem(
                      tooltip(points[s.x.toInt()]),
                      const TextStyle(
                        fontFamily: AppTypography.fontMono,
                        fontSize: StrideTokens.fs11,
                        color: _tooltipFg,
                      ),
                    )
                  else
                    LineTooltipItem(
                      secondTooltip!(secondLine!.points[s.x.toInt()]),
                      const TextStyle(
                        fontFamily: AppTypography.fontMono,
                        fontSize: StrideTokens.fs11,
                        color: _tooltipFg,
                      ),
                    ),
              ],
            ),
          ),
          lineBarsData: [
            LineChartBarData(
              spots: spots,
              color: _rhrColor,
              barWidth: 2,
              dotData: const FlDotData(show: false),
            ),
            if (secondLine != null)
              LineChartBarData(
                spots: secondSpots,
                color: secondLine.color,
                barWidth: 2,
                dotData: const FlDotData(show: false),
              ),
          ],
        ),
      ),
    );
  }

  FlSpot _spot(int i, ({String label, double? y}) p) =>
      p.y == null ? FlSpot.nullSpot : FlSpot(i.toDouble(), p.y!);

  /// 柱状卡（uCharts column 对照）：null 柱 = 透明占位（缺口）。
  Widget _barChart({
    required List<({String label, double? y})> points,
    required double maxY,
    required Color defaultColor,
    required String Function(({String label, double? y})) tooltip,
    List<Color Function(int index)>? colorPerRod,
  }) {
    return SizedBox(
      height: 140,
      child: BarChart(
        BarChartData(
          minY: 0,
          maxY: maxY <= 0 ? 1 : maxY,
          alignment: BarChartAlignment.spaceAround,
          gridData: const FlGridData(show: false),
          borderData: FlBorderData(show: false),
          titlesData: _titles(points.length, (i) => points[i.toInt()].label),
          barTouchData: BarTouchData(
            touchTooltipData: BarTouchTooltipData(
              getTooltipColor: (_) => _tooltipBg,
              fitInsideHorizontally: true,
              getTooltipItem: (group, gi, rod, _) =>
                  rod.color == Colors.transparent
                      ? null
                      : BarTooltipItem(
                          tooltip(points[gi]),
                          const TextStyle(
                            fontFamily: AppTypography.fontMono,
                            fontSize: StrideTokens.fs11,
                            color: _tooltipFg,
                          ),
                        ),
            ),
          ),
          barGroups: [
            for (var i = 0; i < points.length; i++)
              BarChartGroupData(
                x: i,
                barRods: [
                  BarChartRodData(
                    toY: points[i].y ?? 0,
                    color: points[i].y == null
                        ? Colors.transparent
                        : defaultColor,
                    width: points.length > 45 ? 3 : 6,
                    borderRadius: const BorderRadius.vertical(
                      top: Radius.circular(2),
                    ),
                  ),
                ],
              ),
          ],
        ),
      ),
    );
  }

  /// Form 柱 —— 逐点五档配色 + zone 中文工具提示。
  Widget _formBarChart({
    required List<({String label, double? y, Color color})> points,
    required double minY,
    required double maxY,
    required Map<String, double?> chronicByLabel,
  }) {
    return SizedBox(
      height: 140,
      child: BarChart(
        BarChartData(
          minY: minY,
          maxY: maxY == minY ? minY + 1 : maxY,
          alignment: BarChartAlignment.spaceAround,
          gridData: const FlGridData(show: false),
          borderData: FlBorderData(show: false),
          titlesData: _titles(points.length, (i) => points[i.toInt()].label),
          barTouchData: BarTouchData(
            touchTooltipData: BarTouchTooltipData(
              getTooltipColor: (_) => _tooltipBg,
              fitInsideHorizontally: true,
              getTooltipItem: (group, gi, rod, _) {
                if (rod.color == Colors.transparent) return null;
                final p = points[gi];
                final zone = classifyForm(p.y, chronicByLabel[p.label]);
                final zoneText = zone == null ? '' : '（${formZoneLabel[zone]}）';
                return BarTooltipItem(
                  '${p.label} · Form ${p.y! > 0 ? '+' : ''}'
                  '${p.y!.toStringAsFixed(1)}$zoneText',
                  const TextStyle(
                    fontFamily: AppTypography.fontMono,
                    fontSize: StrideTokens.fs11,
                    color: _tooltipFg,
                  ),
                );
              },
            ),
          ),
          barGroups: [
            for (var i = 0; i < points.length; i++)
              BarChartGroupData(
                x: i,
                barRods: [
                  BarChartRodData(
                    toY: points[i].y ?? 0,
                    color: points[i].y == null
                        ? Colors.transparent
                        : points[i].color,
                    width: points.length > 45 ? 3 : 6,
                    borderRadius: const BorderRadius.vertical(
                      top: Radius.circular(2),
                    ),
                  ),
                ],
              ),
          ],
        ),
      ),
    );
  }

  FlTitlesData _titles(int count, String Function(int) labelAt) {
    TextStyle axisStyle() => const TextStyle(
          fontFamily: AppTypography.fontMono,
          fontSize: StrideTokens.fs10,
          color: StrideTokens.muted,
        );
    // x 轴 labelCount 3 对照：约 3 个均匀刻度。
    final step = count <= 3 ? 1 : (count / 3).ceil();
    return FlTitlesData(
      topTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
      rightTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
      leftTitles: AxisTitles(
        sideTitles: SideTitles(
          showTitles: true,
          reservedSize: 34,
          maxIncluded: false,
          minIncluded: false,
          getTitlesWidget: (v, meta) => Text(
            _axisNum(v),
            style: axisStyle(),
          ),
        ),
      ),
      bottomTitles: AxisTitles(
        sideTitles: SideTitles(
          showTitles: true,
          reservedSize: 16,
          getTitlesWidget: (v, meta) {
            final i = v.toInt();
            if (i < 0 || i >= count || i % step != 0) {
              return const SizedBox.shrink();
            }
            return Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(labelAt(i), style: axisStyle()),
            );
          },
        ),
      ),
    );
  }

  String _axisNum(double v) {
    if (v.abs() >= 100) return v.round().toString();
    if (v.abs() >= 10) return v.toStringAsFixed(0);
    return v.toStringAsFixed(1);
  }

  Widget _formLegendAndNote(StrideTrainingLoadRecord cur) {
    final ctl = cur.chronicLoad;
    const zones = [
      (FormZone.raceReady, '比赛就绪 (+10%~+25%×CTL)'),
      (FormZone.transition, '维持期 (±10%×CTL)'),
      (FormZone.productive, '提升期 (−25%~−10%×CTL)'),
      (FormZone.overload, '过度负荷 (<−25%×CTL)'),
      (FormZone.overTaper, '减量过多 (>+25%×CTL)'),
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: StrideTokens.spaceMd),
        Wrap(
          spacing: StrideTokens.spaceMd,
          runSpacing: StrideTokens.spaceXs,
          children: [
            for (final (zone, label) in zones)
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    width: 8,
                    height: 8,
                    decoration: BoxDecoration(
                      color: Color(formZoneColor[zone]!),
                      shape: BoxShape.circle,
                    ),
                  ),
                  const SizedBox(width: 4),
                  Text(
                    label,
                    style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs10,
                      color: StrideTokens.muted,
                    ),
                  ),
                ],
              ),
          ],
        ),
        if (ctl != null && ctl > 0) ...[
          const SizedBox(height: StrideTokens.spaceSm),
          Text(
            '当前 CTL ≈ ${ctl.round()} · 对应阈值 ±${(ctl * 0.1).round()} / ±${(ctl * 0.25).round()}',
            style: const TextStyle(
              fontFamily: AppTypography.fontMono,
              fontSize: StrideTokens.fs11,
              color: StrideTokens.muted,
            ),
          ),
        ],
      ],
    );
  }

  String _paceRange(String? upper, String? lower) {
    if (upper != null && lower != null) return '$upper – $lower';
    if (upper != null) return '≥ $upper';
    if (lower != null) return '≤ $lower';
    return '—';
  }

  String _bpmRange(int? lo, int? hi) {
    if (lo != null && hi != null) return '$lo – $hi';
    if (lo != null) return '≥ $lo';
    if (hi != null) return '≤ $hi';
    return '—';
  }
}

extension _NonNullIterable<T extends Object> on Iterable<T?> {
  Iterable<T> get nonNull => whereType<T>();
}

// ── 核心指标 4 卡 ─────────────────────────────────────────────────────────────

class _MetricGrid extends StatelessWidget {
  const _MetricGrid({required this.data});

  final TrainingStatusData data;

  @override
  Widget build(BuildContext context) {
    final healthRows = data.health.health;
    final latestRhr = healthRows.isEmpty ? null : healthRows.first.rhr;
    final latestRhrDate =
        healthRows.isEmpty ? null : formatDateShort(healthRows.first.date);
    final rhrBaseline = data.health.rhrBaseline;

    final hrvRows = data.hrv.hrv.where((r) => r.lastNightAvg != null).toList();
    final latestHrv = hrvRows.isEmpty ? null : hrvRows.last.lastNightAvg;
    final latestHrvDate =
        hrvRows.isEmpty ? null : formatDateShort(hrvRows.last.date);
    final hrvLow = data.health.hrv.hrvNormalLow;
    final hrvHigh = data.health.hrv.hrvNormalHigh;

    final threshold = data.zones.threshold;
    final pace = threshold?.pacePerKmSec;
    final hr = threshold?.hrBpm;

    return GridView.count(
      crossAxisCount: 2,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      mainAxisSpacing: StrideTokens.spaceMd,
      crossAxisSpacing: StrideTokens.spaceMd,
      childAspectRatio: 1.35,
      children: [
        MetricCard(
          key: const Key('ts-metric-rhr'),
          title: '静息心率',
          value: latestRhr != null ? '$latestRhr' : '—',
          unit: 'bpm',
          subtitle: latestRhrDate != null ? '$latestRhrDate · 手表读数' : null,
          pill: rhrBaseline != null ? '基线 $rhrBaseline bpm' : null,
        ),
        MetricCard(
          key: const Key('ts-metric-hrv'),
          title: '心率变异性',
          value: latestHrv != null ? '$latestHrv' : '—',
          unit: 'ms',
          subtitle: latestHrvDate != null ? '$latestHrvDate · 手表读数' : null,
          pill: hrvLow != null && hrvHigh != null
              ? '正常 ${hrvLow?.round()}–${hrvHigh?.round()} ms'
              : null,
        ),
        MetricCard(
          key: const Key('ts-metric-pace'),
          title: '阈值配速',
          value: pace != null ? paceFmt(pace).replaceAll('/km', '') : '—',
          unit: '/km',
          subtitle: 'STRIDE Threshold Pace',
          pill: threshold?.speedConfidence != null
              ? '置信 ${threshold!.speedConfidence}'
              : null,
        ),
        MetricCard(
          key: const Key('ts-metric-hr'),
          title: '阈值心率',
          value: hr != null ? '${hr.round()}' : '—',
          unit: 'bpm',
          subtitle: 'STRIDE Threshold HR',
          pill: threshold?.hrConfidence != null
              ? '置信 ${threshold!.hrConfidence}'
              : null,
        ),
      ],
    );
  }
}

// ── 负荷 6 指标 + readiness 门控 ─────────────────────────────────────────────

class _LoadSummaryCard extends StatelessWidget {
  const _LoadSummaryCard({required this.cur});

  final StrideTrainingLoadRecord cur;

  @override
  Widget build(BuildContext context) {
    final gate = cur.readinessGate;
    final gateColor = Color(readinessColor(gate));
    final stats = <(String, String, Color)>[
      (
        '训练负荷',
        cur.trainingDose == 0 && cur.isUnknown ? '—' : cur.trainingDose.round().toString(),
        _doseColor,
      ),
      ('急性负荷', cur.acuteLoad.toStringAsFixed(1), const Color(0xFFD97706)),
      ('慢性负荷', cur.chronicLoad.toStringAsFixed(1), _chronicColor),
      (
        '竞技状态',
        '${cur.form > 0 ? '+' : ''}${cur.form.toStringAsFixed(1)}',
        classifyForm(cur.form, cur.chronicLoad) == FormZone.overload
            ? const Color(0xFFD32F2F)
            : _chronicColor,
      ),
      ('负荷比', cur.loadRatio?.toStringAsFixed(2) ?? '—', _hrvColor),
      ('状态', loadStateLabel(cur.loadRatio), const Color(0xFF8888A0)),
    ];

    return Container(
      key: const Key('ts-load-summary'),
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              for (var i = 0; i < 3; i++)
                Expanded(child: _stat(stats[i])),
            ],
          ),
          const SizedBox(height: StrideTokens.spaceMd),
          Row(
            children: [
              for (var i = 3; i < 6; i++)
                Expanded(child: _stat(stats[i])),
            ],
          ),
          const SizedBox(height: StrideTokens.spaceMd),
          Wrap(
            spacing: StrideTokens.spaceSm,
            runSpacing: StrideTokens.spaceXs,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              if (gate != null)
                Container(
                  key: const Key('ts-readiness'),
                  padding: const EdgeInsets.symmetric(
                    horizontal: StrideTokens.spaceMd,
                    vertical: 4,
                  ),
                  decoration: BoxDecoration(
                    color: gateColor.withValues(alpha: 0.12),
                    borderRadius:
                        BorderRadius.circular(StrideTokens.radiusPill),
                  ),
                  child: Text(
                    '${readinessGateLabel(gate)} · ${readinessAdvice(gate)}',
                    style: TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs12,
                      fontWeight: FontWeight.w600,
                      color: gateColor,
                    ),
                  ),
                ),
              for (final r in cur.readinessReasons)
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: StrideTokens.spaceSm,
                    vertical: 3,
                  ),
                  decoration: BoxDecoration(
                    color: StrideTokens.bg,
                    borderRadius:
                        BorderRadius.circular(StrideTokens.radiusPill),
                    border: Border.all(color: StrideTokens.border2),
                  ),
                  child: Text(
                    readinessReasonLabel(r),
                    key: Key('ts-reason-$r'),
                    style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs11,
                      color: StrideTokens.muted,
                    ),
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _stat((String, String, Color) s) {
    final (label, value, color) = s;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: const TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs11,
            color: StrideTokens.muted,
          ),
        ),
        const SizedBox(height: 2),
        Text(
          value,
          style: TextStyle(
            fontFamily: AppTypography.fontMono,
            fontSize: StrideTokens.fs15,
            fontWeight: FontWeight.w700,
            color: color,
          ),
        ),
      ],
    );
  }
}

// ── 16 周热力图 ──────────────────────────────────────────────────────────────

class _HeatmapCard extends StatelessWidget {
  const _HeatmapCard({
    required this.data,
    required this.selected,
    required this.onCellTap,
  });

  final TrainingStatusData data;
  final String? selected;
  final void Function(String date) onCellTap;

  @override
  Widget build(BuildContext context) {
    final cells = buildHeatCells(data.load.series);
    final weeks = buildHeatWeeks(cells);
    final cellByKey = {for (final c in cells) c.date: c};

    return Container(
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            '16 周训练热力图',
            style: TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs12,
              color: StrideTokens.muted,
            ),
          ),
          const SizedBox(height: StrideTokens.spaceMd),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(
                width: 16,
                child: Column(
                  children: [
                    const SizedBox(height: 14), // 月份标签行高
                    for (final l in ['一', '', '三', '', '五', '', ''])
                      SizedBox(
                        height: _HeatmapGrid.cellSize,
                        child: Text(
                          l,
                          style: const TextStyle(
                            fontFamily: AppTypography.fontSans,
                            fontSize: 9,
                            color: StrideTokens.muted2,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
              Expanded(
                child: Row(
                  children: [
                    for (final w in weeks)
                      Expanded(
                        child: Column(
                          children: [
                            SizedBox(
                              height: 14,
                              child: Text(
                                w.month,
                                style: const TextStyle(
                                  fontFamily: AppTypography.fontSans,
                                  fontSize: 9,
                                  color: StrideTokens.muted2,
                                ),
                              ),
                            ),
                            for (final c in w.cells)
                              _HeatmapGrid(
                                cell: c,
                                selected: selected == c.date,
                                onTap: () => onCellTap(c.date),
                              ),
                          ],
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: StrideTokens.spaceSm),
          Row(
            children: [
              const Text(
                '少',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs10,
                  color: StrideTokens.muted2,
                ),
              ),
              const SizedBox(width: 6),
              for (final c in heatmapColors) ...[
                Container(
                  width: 10,
                  height: 10,
                  decoration: BoxDecoration(
                    color: Color(c),
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
                const SizedBox(width: 4),
              ],
              const Text(
                '多',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs10,
                  color: StrideTokens.muted2,
                ),
              ),
            ],
          ),
          if (selected != null && cellByKey[selected] != null) ...[
            const SizedBox(height: StrideTokens.spaceMd),
            _HeatDetail(
              cell: cellByKey[selected]!,
              activities: data.activitiesByDate[selected] ?? const [],
            ),
          ],
        ],
      ),
    );
  }
}

class _HeatmapGrid extends StatelessWidget {
  const _HeatmapGrid({
    required this.cell,
    required this.selected,
    required this.onTap,
  });

  static const cellSize = 14.0;

  final HeatCell cell;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final Color fill;
    switch (cell.state) {
      case HeatDayState.active:
        fill = Color(heatmapColors[cell.bucket]);
      case HeatDayState.unknown:
        fill = const Color(0x33000000);
      case HeatDayState.future:
        fill = Colors.transparent;
      case HeatDayState.absent:
      case HeatDayState.rest:
        fill = const Color(0x0A000000);
    }
    return GestureDetector(
      onTap: cell.state == HeatDayState.future ? null : onTap,
      child: Container(
        key: Key('ts-heat-${cell.date}'),
        width: cellSize,
        height: cellSize,
        margin: const EdgeInsets.all(1),
        decoration: BoxDecoration(
          color: fill,
          borderRadius: BorderRadius.circular(3),
          border: cell.isToday
              ? Border.all(color: StrideTokens.accent, width: 1.5)
              : selected
                  ? Border.all(color: StrideTokens.fgSoft, width: 1.2)
                  : null,
        ),
      ),
    );
  }
}

class _HeatDetail extends StatelessWidget {
  const _HeatDetail({required this.cell, required this.activities});

  final HeatCell cell;
  final List<Activity> activities;

  @override
  Widget build(BuildContext context) {
    final String doseText;
    switch (cell.state) {
      case HeatDayState.unknown:
        doseText = '数据未确认';
      case HeatDayState.absent:
        doseText = '历史无记录';
      default:
        doseText = cell.dose != null ? '训练负荷 ${cell.dose!.round()}' : '训练负荷 —';
    }

    final lines = <String>[];
    for (final a in activities) {
      final sport = chineseSportName(a.sportName);
      final hr = a.avgHr?.toString() ?? '—';
      if (isDistanceSport(a.sportName)) {
        final pace = a.paceFmt.replaceAll('/km', '');
        lines.add(
          '$sport ${a.distanceKm.toStringAsFixed(1)}km · '
          '平均配速 $pace · 平均心率 $hr',
        );
      } else {
        lines.add('$sport ${formatDurationHuman(a.durationS)} · 平均心率 $hr');
      }
    }
    if (lines.isEmpty && cell.state == HeatDayState.rest) lines.add('休息日');

    return Container(
      key: const Key('ts-heat-detail'),
      padding: const EdgeInsets.all(StrideTokens.spaceMd),
      decoration: BoxDecoration(
        color: StrideTokens.bg,
        borderRadius: BorderRadius.circular(StrideTokens.radiusSm),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '${formatDateShort(cell.date)} · ${shanghaiWeekdayLabel(cell.date)}',
            style: const TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs13,
              fontWeight: FontWeight.w600,
              color: StrideTokens.fg,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            doseText,
            style: const TextStyle(
              fontFamily: AppTypography.fontMono,
              fontSize: StrideTokens.fs12,
              color: StrideTokens.fgSoft,
            ),
          ),
          for (final l in lines)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(
                l,
                style: const TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs11,
                  color: StrideTokens.muted,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

// ── 区间两表 ─────────────────────────────────────────────────────────────────

class _ZoneRow {
  const _ZoneRow({
    required this.name,
    required this.label,
    required this.range,
    required this.nameColor,
  });

  final String name;
  final String label;
  final String range;
  final Color nameColor;
}

class _ZoneTableCard extends StatelessWidget {
  const _ZoneTableCard({required this.label, required this.rows});

  final String label;
  final List<_ZoneRow> rows;

  @override
  Widget build(BuildContext context) {
    TextStyle cellStyle({Color color = StrideTokens.fgSoft, bool bold = false}) =>
        TextStyle(
          fontFamily: AppTypography.fontMono,
          fontSize: StrideTokens.fs12,
          fontWeight: bold ? FontWeight.w700 : FontWeight.w400,
          color: color,
        );

    return Container(
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: const TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs12,
              color: StrideTokens.muted,
            ),
          ),
          const SizedBox(height: StrideTokens.spaceMd),
          Row(
            children: [
              Expanded(child: Text('Zone', style: cellStyle(color: StrideTokens.muted))),
              Expanded(child: Text('名称', style: cellStyle(color: StrideTokens.muted))),
              Expanded(
                child: Text('区间', style: cellStyle(color: StrideTokens.muted)),
              ),
            ],
          ),
          const SizedBox(height: 6),
          for (final r in rows)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Row(
                children: [
                  Expanded(child: Text(r.name, style: cellStyle(color: r.nameColor, bold: true))),
                  Expanded(child: Text(r.label, style: cellStyle())),
                  Expanded(child: Text(r.range, style: cellStyle())),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

// ── footer + 页尾三 tile ─────────────────────────────────────────────────────

class _FooterLines extends StatelessWidget {
  const _FooterLines({required this.data});

  final TrainingStatusData data;

  @override
  Widget build(BuildContext context) {
    const lineStyle = TextStyle(
      fontFamily: AppTypography.fontMono,
      fontSize: StrideTokens.fs11,
      color: StrideTokens.muted2,
      height: 1.6,
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Calibration: ${data.zones.threshold?.asOfDate ?? '—'} · 来源：STRIDE 自研算法',
          style: lineStyle,
        ),
        Text(
          'Training load latest: ${data.load.current?.date ?? '—'}',
          style: lineStyle,
        ),
        const Text('RHR / HRV: 来自手表原始读数（COROS / Garmin）', style: lineStyle),
      ],
    );
  }
}

/// 页尾三 tile —— App 独有能力（E4/E5/E6，#423 决议迁路由）。
class _DomainTiles extends StatelessWidget {
  const _DomainTiles();

  @override
  Widget build(BuildContext context) {
    const tiles = <(IconData, String, String, String)>[
      (Icons.radar, '能力分析', '6 维 ability radar', '/me/data/ability'),
      (Icons.flag_outlined, '成绩预测', '5K / 10K / HM / FM', '/me/data/predictions'),
      (Icons.emoji_events_outlined, '个人最佳', '4 距离自动检测', '/me/data/pbs'),
    ];
    final tileKeys = const ['ability', 'predictions', 'pbs'];
    return Container(
      decoration: BoxDecoration(
        color: StrideTokens.surface,
        borderRadius: BorderRadius.circular(StrideTokens.radiusLg),
        border: Border.all(color: StrideTokens.border2),
      ),
      child: Column(
        children: [
          for (var i = 0; i < tiles.length; i++) ...[
            if (i > 0)
              const Divider(
                height: 1,
                thickness: 1,
                color: StrideTokens.border2,
                indent: StrideTokens.spaceLg,
                endIndent: StrideTokens.spaceLg,
              ),
            InkWell(
              key: Key('ts-tile-${tileKeys[i]}'),
              onTap: () => context.push(tiles[i].$4),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: StrideTokens.spaceLg,
                  vertical: StrideTokens.spaceMd,
                ),
                child: Row(
                  children: [
                    Icon(tiles[i].$1, size: 20, color: StrideTokens.fgSoft),
                    const SizedBox(width: StrideTokens.spaceLg),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            tiles[i].$2,
                            style: const TextStyle(
                              fontFamily: AppTypography.fontSans,
                              fontSize: StrideTokens.fs14,
                              color: StrideTokens.fg,
                            ),
                          ),
                          Text(
                            tiles[i].$3,
                            style: const TextStyle(
                              fontFamily: AppTypography.fontSans,
                              fontSize: StrideTokens.fs11,
                              color: StrideTokens.muted,
                            ),
                          ),
                        ],
                      ),
                    ),
                    const Icon(
                      Icons.chevron_right,
                      size: 18,
                      color: StrideTokens.muted2,
                    ),
                  ],
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
