/// 训练状态页（/me/training-status）—— 复刻小程序 pages/training-status（#465）。
///
/// 分区（照抄 training-status.wxml 结构清单，#423 决议）：
/// 核心指标 4 卡 / 窗口 toggle(14/30/60/90d) / RHR+HRV 折线 / 负荷 6 指标 /
/// readiness 门控（gate 徽章 + reasons 中文映射）/ 每日 Dose 柱（unknown 缺口）/
/// 慢性 vs 急性双线 / Form 柱逐点五档 / 8 周周剂量 / 16 周热力图（点格日详情）/
/// STRIDE 区间两表 / 页尾三 tile（E4 能力雷达 · E5 预测 · E6 PB）/ footer。
///
/// 口径：form/CTL 相对五档（#423 表）；绝对 TSB 口径随 E2 删除而废弃。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/router/routes.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../../data/models/activity.dart';
import '../../data/models/health.dart';
import '../../data/models/training_status.dart';
import '../../shared/utils/shanghai_date.dart';
import '../_shared/widgets/refreshable.dart';
import '../_shared/widgets/seg_control.dart';
import '../_shared/widgets/top_bar.dart';
import 'models/training_status_data.dart';
import 'providers/training_status_provider.dart';
import 'widgets/ts_charts.dart';

const _cRhr = Color(0xFF0097A7);
const _cHrv = Color(0xFF7A4DD4);
const _cPace = Color(0xFF00A85A);
const _cHr = Color(0xFFD97706);
const _cDose = Color(0xFFE68A00);
const _cChronic = Color(0xFF00A85A);
const _cAcute = Color(0xFF0097A7);

class TrainingStatusScreen extends ConsumerStatefulWidget {
  const TrainingStatusScreen({super.key});

  @override
  ConsumerState<TrainingStatusScreen> createState() =>
      _TrainingStatusScreenState();
}

const _windowOptions = ['14d', '30d', '60d', '90d'];
const _windowValues = [14, 30, 60, 90];

class _TrainingStatusScreenState extends ConsumerState<TrainingStatusScreen> {
  int _trendDays = 30;
  String? _heatSelected;

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(trainingStatusProvider);
    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: const StrideTopBar(title: '训练状态'),
      body: async.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => _ErrorView(message: e.toString()),
        data: (data) => StrideRefreshable(
          provider: trainingStatusProvider.future,
          child: _Body(
            data: data,
            trendDays: _trendDays,
            onWindowChanged: (i) =>
                setState(() => _trendDays = _windowValues[i]),
            heatSelected: _heatSelected,
            onHeatTap: (date) => setState(
                () => _heatSelected = _heatSelected == date ? null : date),
          ),
        ),
      ),
    );
  }
}

// ── Body ─────────────────────────────────────────────────────────────────────

class _Body extends StatelessWidget {
  const _Body({
    required this.data,
    required this.trendDays,
    required this.onWindowChanged,
    required this.heatSelected,
    required this.onHeatTap,
  });

  final TrainingStatusData data;
  final int trendDays;
  final void Function(int) onWindowChanged;
  final String? heatSelected;
  final void Function(String) onHeatTap;

  @override
  Widget build(BuildContext context) {
    final cur = data.load.current;
    final hasLoad = cur != null;

    return ListView(
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      children: [
        const _SectionTitle('核心指标'),
        _MetricGrid(data: data),
        const SizedBox(height: StrideTokens.spaceXl),

        // ── 趋势 ──
        Row(
          children: [
            const Expanded(child: _SectionTitle('趋势')),
            SizedBox(
              width: 168,
              child: StrideSegControl(
                options: _windowOptions,
                selectedIndex: _windowValues.indexOf(trendDays),
                onChanged: onWindowChanged,
              ),
            ),
          ],
        ),
        _Card(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const _ChartLabel('静息心率 · 手表读数'),
              _rhrChart(),
            ],
          ),
        ),
        const SizedBox(height: StrideTokens.spaceMd),
        _Card(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const _ChartLabel('心率变异性 · 手表读数'),
              _hrvChart(),
            ],
          ),
        ),

        // ── 训练负荷 ──
        if (hasLoad) ...[
          const SizedBox(height: StrideTokens.spaceXl),
          const _SectionTitle('训练负荷'),
          _LoadCard(cur: cur),
          const SizedBox(height: StrideTokens.spaceMd),
          _cardWithLabel('每日训练负荷（Dose）', _doseChart()),
          const SizedBox(height: StrideTokens.spaceMd),
          _cardWithLabel(
            '慢性负荷（42日 EWMA） vs 急性负荷（7日 EWMA）',
            _loadChart(),
          ),
          const SizedBox(height: StrideTokens.spaceMd),
          _cardWithLabel(
            '竞技状态 Form（慢性负荷 − 急性负荷）',
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _formChart(),
                const SizedBox(height: StrideTokens.spaceSm),
                const _FormLegend(),
                if ((cur.chronicLoad ?? 0) > 0) ...[
                  const SizedBox(height: StrideTokens.spaceXs),
                  _CtlNote(cur: cur),
                ],
              ],
            ),
          ),
          const SizedBox(height: StrideTokens.spaceMd),
          _cardWithLabel('8 周负荷趋势', _weekChart()),
          const SizedBox(height: StrideTokens.spaceMd),
          _cardWithLabel(
            '16 周训练热力图',
            _Heatmap(
              series: data.load.series,
              activitiesByDate: data.activitiesByDate,
              selected: heatSelected,
              onTap: onHeatTap,
            ),
          ),
        ],

        // ── STRIDE 区间 ──
        if (data.zones.hasZones) ...[
          const SizedBox(height: StrideTokens.spaceXl),
          const _SectionTitle('STRIDE 区间'),
          _ZoneTableCard(
            label: '配速区间',
            rows: [
              for (final z in data.zones.paceZones)
                _ZoneRowData(
                  z.name,
                  z.label,
                  _paceRange(z.upperPace, z.lowerPace),
                  isPace: true,
                ),
            ],
          ),
          const SizedBox(height: StrideTokens.spaceMd),
          _ZoneTableCard(
            label: '心率区间',
            rows: [
              for (final z in data.zones.hrZones)
                _ZoneRowData(z.name, z.label, _hrRange(z.lowerBpm, z.upperBpm)),
            ],
          ),
        ],

        // ── 页尾三 tile（E4-E6 迁路由）──
        const SizedBox(height: StrideTokens.spaceXl),
        const _DetailEntries(),
        const SizedBox(height: StrideTokens.spaceXl),

        // ── footer ──
        _footerLine(
            'Calibration: ${data.zones.threshold?.asOfDate ?? '—'} · 来源：STRIDE 自研算法'),
        _footerLine('Training load latest: ${cur?.date ?? '—'}'),
        _footerLine('RHR / HRV: 来自手表原始读数（COROS / Garmin）'),
        const SizedBox(height: StrideTokens.space3xl),
      ],
    );
  }

  static const _footerStyle = TextStyle(
    fontFamily: AppTypography.fontSans,
    fontSize: StrideTokens.fs11,
    color: StrideTokens.muted,
  );

  static Widget _footerLine(String text) => Padding(
        padding: const EdgeInsets.only(bottom: 2),
        child: Text(text, style: _footerStyle),
      );

  Widget _cardWithLabel(String label, Widget child) => _Card(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _ChartLabel(label),
            child,
          ],
        ),
      );

  // ── 趋势切片（window toggle 全量重渲）──

  /// API 返回 DESC（最新在前）；反转为 ASC 后取窗口尾部。
  List<HealthRecord> get _rhrAsc => data.health.health
      .where((r) => r.rhr != null)
      .toList()
      .reversed
      .toList();

  List<HrvDailyRecord> get _hrvAsc => data.hrv.hrv
      .where((r) => r.lastNightAvg != null)
      .toList(); // 后端 ASC

  List<TrainingLoadRecord> get _seriesAsc =>
      data.load.series; // Go 端按日期升序输出

  Widget _rhrChart() {
    final rows = _rhrAsc.length > trendDays
        ? _rhrAsc.sublist(_rhrAsc.length - trendDays)
        : _rhrAsc;
    final base = data.health.rhrBaseline?.toDouble();
    final series = [for (final r in rows) r.rhr!.toDouble()];
    if (series.length < 2) return const _ChartEmpty('暂无 RHR 数据');
    var min = series.reduce(_minD);
    var max = series.reduce(_maxD);
    if (base != null) {
      min = _minD(min, base);
      max = _maxD(max, base);
    }
    final b = padBounds(min, max, 2);
    return TsLineChart(
      labels: [for (final r in rows) formatDateShort(r.date)],
      series: [
        TsLineSeries(name: '静息心率', color: _cRhr, values: series),
      ],
      minY: b.min,
      maxY: b.max,
      tooltipLines: [
        for (var i = 0; i < rows.length; i++)
          [
            '${formatDateShort(rows[i].date)} · RHR ${rows[i].rhr} bpm',
          ],
      ],
    );
  }

  Widget _hrvChart() {
    final low = data.health.hrv.hrvNormalLow?.toDouble();
    final high = data.health.hrv.hrvNormalHigh?.toDouble();
    final rows = _hrvAsc.length > trendDays
        ? _hrvAsc.sublist(_hrvAsc.length - trendDays)
        : _hrvAsc;
    final series = rows.map((r) => r.lastNightAvg!.toDouble()).toList();
    if (series.length < 2) return const _ChartEmpty('暂无 HRV 数据');
    var min = series.reduce(_minD);
    var max = series.reduce(_maxD);
    if (low != null) min = _minD(min, low);
    if (high != null) max = _maxD(max, high);
    final b = padBounds(min, max, 5);
    return TsLineChart(
      labels: [for (final r in rows) formatDateShort(r.date)],
      series: [
        TsLineSeries(name: '心率变异性', color: _cHrv, values: series),
      ],
      minY: b.min,
      maxY: b.max,
      tooltipLines: [
        for (var i = 0; i < rows.length; i++)
          [
            '${formatDateShort(rows[i].date)} · HRV ${rows[i].lastNightAvg} ms',
          ],
      ],
    );
  }

  List<TrainingLoadRecord> get _windowSeries => _seriesAsc.length > trendDays
      ? _seriesAsc.sublist(_seriesAsc.length - trendDays)
      : _seriesAsc;

  Widget _doseChart() {
    final rows = _windowSeries;
    final values = [
      for (final r in rows) r.isUnknown ? null : r.trainingDose?.toDouble(),
    ];
    final known = values.whereType<double>().toList();
    if (known.isEmpty) return const _ChartEmpty('暂无训练负荷数据');
    return TsColumnChart(
      labels: [for (final r in rows) formatDateShort(r.date)],
      values: values,
      colors: [for (final _ in rows) _cDose],
      minY: 0,
      maxY: _maxD(10, _maxOf(known) * 1.1),
      tooltip: (i, v) => '${formatDateShort(rows[i].date)} · 训练负荷 ${v.round()}',
    );
  }

  Widget _loadChart() {
    final rows = _windowSeries;
    final chronic = [
      for (final r in rows) r.isUnknown ? null : r.chronicLoad?.toDouble(),
    ];
    final acute = [
      for (final r in rows) r.isUnknown ? null : r.acuteLoad?.toDouble(),
    ];
    final known = [...chronic.nonNulls, ...acute.nonNulls];
    if (known.length < 2) return const _ChartEmpty('暂无趋势数据');
    final min = known.reduce(_minD);
    final max = known.reduce(_maxD);
    final b = padBounds(min, max, _maxD(1, (max - min) * 0.1));
    return TsLineChart(
      labels: [for (final r in rows) formatDateShort(r.date)],
      series: [
        TsLineSeries(name: '慢性负荷', color: _cChronic, values: chronic),
        TsLineSeries(name: '急性负荷', color: _cAcute, values: acute),
      ],
      minY: b.min,
      maxY: b.max,
    );
  }

  Widget _formChart() {
    final rows = _windowSeries;
    final values = [
      for (final r in rows) r.isUnknown ? null : r.form?.toDouble(),
    ];
    if (values.whereType<double>().isEmpty) {
      return const _ChartEmpty('暂无 Form 数据');
    }
    final min = _minD(0.0, values.whereType<double>().reduce(_minD));
    final max = _maxD(0.0, values.whereType<double>().reduce(_maxD));
    final b = padBounds(min, max, _maxD(0.5, (max - min) * 0.1));
    return TsColumnChart(
      labels: [for (final r in rows) formatDateShort(r.date)],
      values: values,
      colors: [for (final r in rows) formColorOf(r.form, r.chronicLoad)],
      minY: b.min,
      maxY: b.max,
      tooltip: (i, v) {
        final r = rows[i];
        final zone = classifyForm(v, r.chronicLoad);
        final sign = v > 0 ? '+' : '';
        return '${formatDateShort(r.date)} · Form $sign${v.toStringAsFixed(1)}'
            '${zone == null ? '' : '（${formZoneLabel[zone]}）'}';
      },
    );
  }

  Widget _weekChart() {
    final buckets = aggregateWeeklyDose(data.load.series);
    final values = [for (final b in buckets) b.totalDose];
    final known = values.whereType<double>().toList();
    if (known.isEmpty) return const _ChartEmpty('暂无周剂量数据');
    return TsLineChart(
      labels: [for (final b in buckets) b.weekLabel],
      series: [TsLineSeries(name: '周剂量', color: _cDose, values: values)],
      minY: 0,
      maxY: _maxD(10, _maxOf(known) * 1.1),
      height: 120,
      tooltipLines: [
        for (var i = 0; i < buckets.length; i++)
          [
            if (values[i] == null)
              '周一 ${buckets[i].weekLabel} · 数据不完整'
            else
              '周一 ${buckets[i].weekLabel} · '
                  '${values[i]!.toStringAsFixed(1)}（${buckets[i].activeDays} 天）',
          ],
      ],
    );
  }
}

double _minD(double a, double b) => a < b ? a : b;
double _maxD(double a, double b) => a > b ? a : b;
double _maxOf(List<double> v) => v.reduce(_maxD);

// ── 核心指标 4 卡 ─────────────────────────────────────────────────────────────

class _MetricGrid extends StatelessWidget {
  const _MetricGrid({required this.data});

  final TrainingStatusData data;

  @override
  Widget build(BuildContext context) {
    // RHR：API DESC，第一个有值的就是最新。
    final rhrRow = data.health.health
        .where((r) => r.rhr != null)
        .cast<HealthRecord?>()
        .firstOrNull;
    final hrvRow = data.hrv.hrv
        .where((r) => r.lastNightAvg != null)
        .cast<HrvDailyRecord?>()
        .firstOrNull;
    final t = data.zones.threshold;
    final hrvLow = data.health.hrv.hrvNormalLow;
    final hrvHigh = data.health.hrv.hrvNormalHigh;

    final cards = <_MetricCard>[
      _MetricCard(
        label: '静息心率',
        sub: rhrRow != null ? '${formatDateShort(rhrRow.date)} · 手表读数' : '手表读数',
        value: rhrRow?.rhr?.toString() ?? '—',
        unit: 'bpm',
        baseline: data.health.rhrBaseline != null
            ? '基线 ${data.health.rhrBaseline} bpm'
            : '',
        color: _cRhr,
      ),
      _MetricCard(
        label: '心率变异性',
        sub: hrvRow != null
            ? '${formatDateShort(hrvRow.date)} · 手表读数'
            : '手表读数',
        value: hrvRow?.lastNightAvg?.toString() ?? '—',
        unit: 'ms',
        baseline: hrvLow != null && hrvHigh != null
            ? '正常 $hrvLow-$hrvHigh ms'
            : '',
        color: _cHrv,
      ),
      _MetricCard(
        label: '阈值配速',
        sub: 'STRIDE Threshold Pace',
        value: t?.pacePerKmSec != null
            ? fmtPace(t!.pacePerKmSec).replaceAll('/km', '')
            : '—',
        unit: '/km',
        baseline:
            (t?.speedConfidence.isNotEmpty ?? false) ? '置信 ${t!.speedConfidence}' : '',
        color: _cPace,
      ),
      _MetricCard(
        label: '阈值心率',
        sub: 'STRIDE Threshold HR',
        value: t?.hrBpm != null ? t!.hrBpm!.round().toString() : '—',
        unit: 'bpm',
        baseline: (t?.hrConfidence.isNotEmpty ?? false)
            ? '置信 ${t!.hrConfidence}'
            : '',
        color: _cHr,
      ),
    ];

    return Column(
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(child: cards[0]),
            const SizedBox(width: StrideTokens.spaceMd),
            Expanded(child: cards[1]),
          ],
        ),
        const SizedBox(height: StrideTokens.spaceMd),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(child: cards[2]),
            const SizedBox(width: StrideTokens.spaceMd),
            Expanded(child: cards[3]),
          ],
        ),
      ],
    );
  }
}

class _MetricCard extends StatelessWidget {
  const _MetricCard({
    required this.label,
    required this.sub,
    required this.value,
    required this.unit,
    required this.baseline,
    required this.color,
  });

  final String label;
  final String sub;
  final String value;
  final String unit;
  final String baseline;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(StrideTokens.spaceMd),
      decoration: _cardDecoration,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: const TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs12,
              fontWeight: FontWeight.w500,
              color: StrideTokens.fgSoft,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            sub,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: 10,
              color: StrideTokens.muted2,
            ),
          ),
          const SizedBox(height: StrideTokens.spaceSm),
          RichText(
            text: TextSpan(
              text: value,
              style: TextStyle(
                fontFamily: AppTypography.fontMono,
                fontSize: StrideTokens.fs22,
                fontWeight: FontWeight.w700,
                color: color,
              ),
              children: [
                if (unit.isNotEmpty)
                  TextSpan(
                    text: ' $unit',
                    style: const TextStyle(
                      fontFamily: AppTypography.fontSans,
                      fontSize: StrideTokens.fs11,
                      fontWeight: FontWeight.w400,
                      color: StrideTokens.muted,
                    ),
                  ),
              ],
            ),
          ),
          if (baseline.isNotEmpty) ...[
            const SizedBox(height: StrideTokens.spaceXs),
            Text(
              baseline,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: 10,
                color: StrideTokens.muted,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

// ── 负荷 6 指标 + readiness 门控 ─────────────────────────────────────────────

class _LoadCard extends StatelessWidget {
  const _LoadCard({required this.cur});

  final TrainingLoadRecord cur;

  @override
  Widget build(BuildContext context) {
    final form = cur.form?.toDouble();
    final chronic = cur.chronicLoad?.toDouble();
    final formZone = classifyForm(form, chronic);
    final gate = cur.readinessGate;
    final gateColor = readinessColor(gate);
    final reasons = readinessReasonsText(cur.readinessReasons);

    final stats = <(String, String, Color)>[
      (
        '训练负荷',
        cur.trainingDose?.toStringAsFixed(0) ?? '—',
        _cDose,
      ),
      ('急性负荷', cur.acuteLoad?.toStringAsFixed(1) ?? '—', _cHr),
      ('慢性负荷', cur.chronicLoad?.toStringAsFixed(1) ?? '—', _cRhr),
      (
        '竞技状态',
        form != null
            ? '${form > 0 ? '+' : ''}${form.toStringAsFixed(1)}'
            : '—',
        formZone == FormZone.overload ? const Color(0xFFD32F2F) : _cChronic,
      ),
      (
        '负荷比',
        cur.loadRatio?.toStringAsFixed(2) ?? '—',
        _cHrv,
      ),
      ('状态', loadStateLabel(cur.loadRatio), const Color(0xFF8888A0)),
    ];

    return _Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              for (var i = 0; i < 3; i++)
                Expanded(child: _LoadStat(stat: stats[i])),
            ],
          ),
          const SizedBox(height: StrideTokens.spaceMd),
          Row(
            children: [
              for (var i = 3; i < 6; i++)
                Expanded(child: _LoadStat(stat: stats[i])),
            ],
          ),
          const SizedBox(height: StrideTokens.spaceLg),
          Container(
            padding: const EdgeInsets.symmetric(
              horizontal: StrideTokens.spaceMd,
              vertical: 6,
            ),
            decoration: BoxDecoration(
              color: gateColor.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(StrideTokens.radiusPill),
            ),
            child: Text(
              gate != null
                  ? '${readinessGateLabel(gate)} · ${readinessLabel(gate)}'
                  : '—',
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs12,
                fontWeight: FontWeight.w600,
                color: gateColor,
              ),
            ),
          ),
          if (reasons.isNotEmpty) ...[
            const SizedBox(height: StrideTokens.spaceSm),
            Text(
              reasons,
              style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs12,
                color: StrideTokens.muted,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _LoadStat extends StatelessWidget {
  const _LoadStat({required this.stat});

  final (String, String, Color) stat;

  @override
  Widget build(BuildContext context) {
    final (label, value, color) = stat;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.center,
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

class _CtlNote extends StatelessWidget {
  const _CtlNote({required this.cur});

  final TrainingLoadRecord cur;

  @override
  Widget build(BuildContext context) {
    final ctl = cur.chronicLoad!.toDouble();
    return Text(
      '当前 CTL ≈ ${ctl.toStringAsFixed(0)} · '
      '对应阈值 ±${(ctl * 0.1).toStringAsFixed(0)} / ±${(ctl * 0.25).toStringAsFixed(0)}',
      style: const TextStyle(
        fontFamily: AppTypography.fontSans,
        fontSize: StrideTokens.fs11,
        color: StrideTokens.muted,
      ),
    );
  }
}

class _FormLegend extends StatelessWidget {
  const _FormLegend();

  static const _items = <(FormZone, String)>[
    (FormZone.raceReady, '比赛就绪 (+10%~+25%×CTL)'),
    (FormZone.transition, '维持期 (±10%×CTL)'),
    (FormZone.productive, '提升期 (−25%~−10%×CTL)'),
    (FormZone.overload, '过度负荷 (<−25%×CTL)'),
    (FormZone.overTaper, '减量过多 (>+25%×CTL)'),
  ];

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: StrideTokens.spaceMd,
      runSpacing: StrideTokens.spaceXs,
      children: [
        for (final (zone, label) in _items)
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(
                  color: formZoneColor[zone],
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 4),
              Text(
                label,
                style: const TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: 10,
                  color: StrideTokens.muted,
                ),
              ),
            ],
          ),
      ],
    );
  }
}

// ── 16 周热力图 ───────────────────────────────────────────────────────────────

class _Heatmap extends StatelessWidget {
  const _Heatmap({
    required this.series,
    required this.activitiesByDate,
    required this.selected,
    required this.onTap,
  });

  final List<TrainingLoadRecord> series;
  final Map<String, List<Activity>> activitiesByDate;
  final String? selected;
  final void Function(String) onTap;

  static const _gutterWidth = 18.0;
  static const _spacing = 2.0;
  static const _monthRowHeight = 14.0;

  @override
  Widget build(BuildContext context) {
    final cells = buildHeatCells(series);
    final monthLabels = heatMonthLabels(cells);
    return LayoutBuilder(
      builder: (context, constraints) {
        final cell =
            (constraints.maxWidth - _gutterWidth - 15 * _spacing) / 16;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: _gutterWidth,
                  child: Column(
                    children: [
                      const SizedBox(height: _monthRowHeight),
                      for (final label in ['一', '', '三', '', '五', '', ''])
                        Container(
                          height: cell + _spacing,
                          alignment: Alignment.centerLeft,
                          child: Text(
                            label,
                            style: const TextStyle(
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
                      for (var w = 0; w < 16; w++) ...[
                        if (w > 0) const SizedBox(width: _spacing),
                        Expanded(
                          child: Column(
                            children: [
                              SizedBox(
                                height: _monthRowHeight,
                                child: monthLabels[w].isEmpty
                                    ? null
                                    : Text(
                                        monthLabels[w],
                                        style: const TextStyle(
                                          fontSize: 9,
                                          color: StrideTokens.muted,
                                        ),
                                      ),
                              ),
                              for (var d = 0; d < 7; d++)
                                Padding(
                                  padding:
                                      const EdgeInsets.only(bottom: _spacing),
                                  child: _cell(
                                    cells[w * 7 + d],
                                    cell,
                                  ),
                                ),
                            ],
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: StrideTokens.spaceSm),
            const _HeatmapLegend(),
            if (selected != null)
              _HeatDetail(
                cell: cells.lastWhere(
                  (c) => c.date == selected,
                  orElse: () => cells.first,
                ),
                activities: activitiesByDate[selected] ?? const [],
              ),
          ],
        );
      },
    );
  }

  Widget _cell(HeatCell c, double size) {
    final color = switch (c.state) {
      HeatDayState.active => heatmapColors[heatmapBucket(c.dose)],
      HeatDayState.rest => heatmapColors[0],
      HeatDayState.unknown => const Color(0x1F8888A0),
      HeatDayState.absent => const Color(0x0F8888A0),
      HeatDayState.future => const Color(0x0A8888A0),
    };
    return GestureDetector(
      key: Key('heat-cell-${c.date}'),
      onTap: c.state == HeatDayState.future ? null : () => onTap(c.date),
      child: Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          color: color,
          borderRadius: BorderRadius.circular(3),
          border: c.isToday
              ? Border.all(color: StrideTokens.accent, width: 1.5)
              : null,
        ),
      ),
    );
  }
}

class _HeatmapLegend extends StatelessWidget {
  const _HeatmapLegend();

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        const Text(
          '少',
          style: TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: 10,
            color: StrideTokens.muted,
          ),
        ),
        const SizedBox(width: 4),
        for (final c in heatmapColors) ...[
          Container(
            width: 12,
            height: 8,
            decoration: BoxDecoration(
              color: c,
              borderRadius: const BorderRadius.all(Radius.circular(2)),
            ),
          ),
          const SizedBox(width: 3),
        ],
        const Text(
          '多',
          style: TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: 10,
            color: StrideTokens.muted,
          ),
        ),
      ],
    );
  }
}

/// 点格日详情：日期+星期+剂量文案+当日活动摘要行。
class _HeatDetail extends StatelessWidget {
  const _HeatDetail({required this.cell, required this.activities});

  final HeatCell cell;
  final List<Activity> activities;

  @override
  Widget build(BuildContext context) {
    final doseText = switch (cell.state) {
      HeatDayState.unknown => '数据未确认',
      HeatDayState.absent => '历史无记录',
      _ => cell.dose != null ? '训练负荷 ${cell.dose!.round()}' : '训练负荷 —',
    };
    final lines = <String>[
      for (final a in activities)
        isDistanceSport(a.sportName)
            ? '${chineseSportName(a.sportName)} ${a.distanceKm}km · '
                '平均配速 ${(a.paceFmt).replaceAll('/km', '')} · 平均心率 ${a.avgHr ?? '—'}'
            : '${chineseSportName(a.sportName)} ${formatDurationHuman(a.durationS)} · '
                '平均心率 ${a.avgHr ?? '—'}',
      if (activities.isEmpty && cell.state == HeatDayState.rest) '休息日',
    ];
    return Container(
      margin: const EdgeInsets.only(top: StrideTokens.spaceSm),
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
              fontSize: StrideTokens.fs12,
              fontWeight: FontWeight.w600,
              color: StrideTokens.fg,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            doseText,
            style: const TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs12,
              color: StrideTokens.fgSoft,
            ),
          ),
          for (final line in lines)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(
                line,
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

// ── STRIDE 区间两表 ───────────────────────────────────────────────────────────

class _ZoneRowData {
  const _ZoneRowData(this.name, this.label, this.range, {this.isPace = false});

  final String name;
  final String label;
  final String range;
  final bool isPace;
}

class _ZoneTableCard extends StatelessWidget {
  const _ZoneTableCard({required this.label, required this.rows});

  final String label;
  final List<_ZoneRowData> rows;

  @override
  Widget build(BuildContext context) {
    return _Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _ChartLabel(label),
          const Row(
            children: [
              Expanded(
                flex: 2,
                child: Text('Zone', style: _zoneHeadStyle),
              ),
              Expanded(flex: 3, child: Text('名称', style: _zoneHeadStyle)),
              Expanded(flex: 4, child: Text('区间', style: _zoneHeadStyle)),
            ],
          ),
          const SizedBox(height: 4),
          for (var i = 0; i < rows.length; i++) ...[
            if (i > 0) const Divider(height: 1, color: StrideTokens.border2),
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Row(
                children: [
                  Expanded(
                    flex: 2,
                    child: Text(
                      rows[i].name,
                      style: TextStyle(
                        fontFamily: AppTypography.fontMono,
                        fontSize: StrideTokens.fs12,
                        fontWeight: FontWeight.w700,
                        color: rows[i].isPace ? _cPace : _cHr,
                      ),
                    ),
                  ),
                  Expanded(
                    flex: 3,
                    child: Text(
                      rows[i].label,
                      style: _zoneCellStyle,
                    ),
                  ),
                  Expanded(
                    flex: 4,
                    child: Text(
                      rows[i].range,
                      style: _zoneCellStyle,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }

  static const _zoneHeadStyle = TextStyle(
    fontFamily: AppTypography.fontSans,
    fontSize: 10,
    color: StrideTokens.muted2,
  );

  static const _zoneCellStyle = TextStyle(
    fontFamily: AppTypography.fontSans,
    fontSize: StrideTokens.fs12,
    color: StrideTokens.fgSoft,
  );
}

/// 配速区间展示「快 – 慢」（upper 在前，同小程序 fmtPaceRange）。
String _paceRange(String? upper, String? lower) {
  if (upper != null && lower != null) return '$upper – $lower';
  if (upper != null) return '≥ $upper';
  if (lower != null) return '≤ $lower';
  return '—';
}

String _hrRange(int? lower, int? upper) {
  if (lower != null && upper != null) return '$lower – $upper';
  if (lower != null) return '≥ $lower';
  if (upper != null) return '≤ $upper';
  return '—';
}

// ── 页尾三 tile（E4-E6）───────────────────────────────────────────────────────

class _DetailEntries extends StatelessWidget {
  const _DetailEntries();

  @override
  Widget build(BuildContext context) {
    const entries = [
      (Icons.radar, '能力分析', '6 维 ability radar', Routes.meDataAbility),
      (
        Icons.flag_outlined,
        '成绩预测',
        '5K / 10K / HM / FM + 目标差距',
        Routes.meDataPredictions,
      ),
      (Icons.emoji_events_outlined, '个人最佳', '4 距离自动检测', Routes.meDataPbs),
    ];
    return Container(
      decoration: _cardDecoration,
      child: Column(
        children: [
          for (var i = 0; i < entries.length; i++) ...[
            if (i > 0)
              const Divider(
                height: 1,
                thickness: 1,
                color: StrideTokens.border2,
                indent: StrideTokens.spaceLg,
                endIndent: StrideTokens.spaceLg,
              ),
            InkWell(
              onTap: () => context.push(entries[i].$4),
              borderRadius: BorderRadius.circular(StrideTokens.radiusLg),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: StrideTokens.spaceLg,
                  vertical: StrideTokens.spaceMd,
                ),
                child: Row(
                  children: [
                    Icon(entries[i].$1, size: 22, color: StrideTokens.accent),
                    const SizedBox(width: StrideTokens.spaceMd),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            entries[i].$2,
                            style: const TextStyle(
                              fontFamily: AppTypography.fontSans,
                              fontSize: StrideTokens.fs14,
                              fontWeight: FontWeight.w500,
                              color: StrideTokens.fg,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            entries[i].$3,
                            style: const TextStyle(
                              fontFamily: AppTypography.fontSans,
                              fontSize: StrideTokens.fs12,
                              color: StrideTokens.muted,
                            ),
                          ),
                        ],
                      ),
                    ),
                    const Icon(
                      Icons.chevron_right,
                      size: 18,
                      color: StrideTokens.muted,
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

// ── 共享小件 ──────────────────────────────────────────────────────────────────

final BoxDecoration _cardDecoration = BoxDecoration(
  color: Colors.white,
  borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
  border: Border.all(color: StrideTokens.border2),
);

class _Card extends StatelessWidget {
  const _Card({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(StrideTokens.spaceLg),
      decoration: _cardDecoration,
      child: child,
    );
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.title);

  final String title;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: StrideTokens.spaceSm),
      child: Text(
        title,
        style: const TextStyle(
          fontFamily: AppTypography.fontSans,
          fontSize: StrideTokens.fs14,
          fontWeight: FontWeight.w700,
          color: StrideTokens.fg,
        ),
      ),
    );
  }
}

class _ChartLabel extends StatelessWidget {
  const _ChartLabel(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: StrideTokens.spaceSm),
      child: Text(
        text,
        style: const TextStyle(
          fontFamily: AppTypography.fontSans,
          fontSize: StrideTokens.fs12,
          fontWeight: FontWeight.w500,
          color: StrideTokens.fgSoft,
        ),
      ),
    );
  }
}

class _ChartEmpty extends StatelessWidget {
  const _ChartEmpty(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 60,
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
  }
}

class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(StrideTokens.space2xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, size: 40, color: StrideTokens.muted),
            const SizedBox(height: StrideTokens.spaceMd),
            const Text(
              '加载失败',
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs15,
                fontWeight: FontWeight.w500,
                color: StrideTokens.fg,
              ),
            ),
            const SizedBox(height: StrideTokens.spaceXs),
            Text(
              message,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs12,
                color: StrideTokens.muted,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
