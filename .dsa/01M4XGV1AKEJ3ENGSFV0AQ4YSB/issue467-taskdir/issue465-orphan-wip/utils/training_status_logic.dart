/// 训练状态页纯函数层 —— 移植自小程序 `utils/trainingStatus.ts`
/// （与 Web `TrainingStatusPage.tsx` 同一套阈值与配色口径，stride-devops#465）：
/// Form 五档 / readiness 门控中文映射 / ACWR 状态 / 16 周热力图 / 8 周周剂量聚合 /
/// 每日活动摘要文案。不碰 Flutter 运行时，可纯 Dart 单测。
library;

import '../../../data/models/training_status.dart';
import '../../../shared/utils/shanghai_date.dart';

// ── Form zone —— 阈值按当日慢性负荷 (CTL) 比例划分 ──────────────────────────

enum FormZone { overTaper, raceReady, transition, productive, overload }

const formZoneColor = <FormZone, int>{
  FormZone.overTaper: 0xFFFFAB00, // 减量过多
  FormZone.raceReady: 0xFF0097A7, // 比赛就绪
  FormZone.transition: 0xFF8888A0, // 维持期
  FormZone.productive: 0xFF00A85A, // 提升期
  FormZone.overload: 0xFFD32F2F, // 过度负荷
};

const formZoneLabel = <FormZone, String>{
  FormZone.overTaper: '减量过多',
  FormZone.raceReady: '比赛就绪',
  FormZone.transition: '维持期',
  FormZone.productive: '提升期',
  FormZone.overload: '过度负荷',
};

FormZone? classifyForm(double? form, double? chronic) {
  if (form == null || chronic == null || chronic <= 0) return null;
  final r = form / chronic;
  if (r > 0.25) return FormZone.overTaper;
  if (r >= 0.1) return FormZone.raceReady;
  if (r >= -0.1) return FormZone.transition;
  if (r >= -0.25) return FormZone.productive;
  return FormZone.overload;
}

/// Form 柱逐点配色；无 CTL 时归中性灰。
int formColor(double? form, double? chronic) =>
    formZoneColor[classifyForm(form, chronic)] ?? 0xFF8888A0;

// ── readiness gate（green / yellow / red）────────────────────────────────────

const readinessColorMap = <String, int>{
  'green': 0xFF00A85A,
  'yellow': 0xFFE68A00,
  'red': 0xFFD32F2F,
};

const readinessAdviceMap = <String, String>{
  'green': '可进行强度训练',
  'yellow': '注意，建议减量',
  'red': '建议停训恢复',
};

const readinessGateLabelMap = <String, String>{
  'green': '绿灯',
  'yellow': '黄灯',
  'red': '红灯',
};

/// readiness reasons 中文映射（顺手修小程序英文 token 直显问题）。
const readinessReasonCn = <String, String>{
  'low_hrv': 'HRV 偏低',
  'rhr_elevated': '静息心率偏高',
  'sleep_debt': '睡眠欠债',
  'ok': '正常',
};

/// readiness 主色；未知 gate 归中性灰，避免异常值看起来像 STOP 信号。
int readinessColor(String? gate) =>
    readinessColorMap[gate] ?? 0xFF8888A0;

String readinessAdvice(String? gate) =>
    gate != null ? (readinessAdviceMap[gate] ?? gate) : '—';

String readinessGateLabel(String? gate) =>
    gate != null ? (readinessGateLabelMap[gate] ?? gate) : '—';

/// 单个 reason token → 中文；未知 token 原样透出。
String readinessReasonLabel(String reason) =>
    readinessReasonCn[reason] ?? reason;

/// 由负荷比（ACWR）衍生的训练状态分类。
String loadStateLabel(double? ratio) {
  if (ratio == null || ratio.isNaN) return '—';
  if (ratio < 0.8) return '恢复期';
  if (ratio < 1.0) return '维持期';
  if (ratio < 1.3) return '提升期';
  return '过度负荷';
}

// ── 16 周训练热力图 ──────────────────────────────────────────────────────────

/// 剂量分桶（与 Web heatmapBucket 一致）：0 空/休息，1–4 递增。
int heatmapBucket(double? dose) {
  if (dose == null || dose <= 0) return 0;
  if (dose <= 40) return 1;
  if (dose <= 80) return 2;
  if (dose <= 120) return 3;
  return 4;
}

/// 橙色渐变（0 = 休息中性底，1–4 = 强度递增）。
const heatmapColors = <int>[
  0x12000000, // 0 = 有记录但零剂量 / 休息
  0x40FF8F3C, // 1 = 轻（1–40）
  0x80FF8F3C, // 2 = 中（41–80）
  0xBFFF8F3C, // 3 = 重（81–120）
  0xFFFF8F3C, // 4 = 最重（>120）
];

enum HeatDayState { active, rest, unknown, absent, future }

class HeatCell {
  const HeatCell({
    required this.date,
    required this.weekIdx,
    required this.dayIdx,
    required this.dose,
    required this.state,
    required this.isToday,
  });

  final String date; // 上海 YYYY-MM-DD
  final int weekIdx; // 0..weeks-1
  final int dayIdx; // 0=Mon .. 6=Sun
  final double? dose;
  final HeatDayState state;
  final bool isToday;

  int get bucket =>
      state == HeatDayState.active ? heatmapBucket(dose) : 0;
}

String _addDays(String ymd, int days) {
  if (!RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(ymd)) return '';
  return epochToShanghaiYmd(shanghaiYmdToEpoch(ymd) + days * 86400000);
}

List<HeatCell> buildHeatCells(
  List<StrideTrainingLoadRecord> series, {
  int weeks = 16,
  String? today,
}) {
  final todayYmd = today ?? shanghaiToday();
  final seriesByDate = {for (final r in series) r.date: r};
  final thisMonday = shanghaiWeekStart(todayYmd);
  final firstMonday = _addDays(thisMonday, -(weeks - 1) * 7);
  final out = <HeatCell>[];
  for (var w = 0; w < weeks; w++) {
    for (var d = 0; d < 7; d++) {
      final date = _addDays(firstMonday, w * 7 + d);
      final row = seriesByDate[date];
      final isFuture = date.compareTo(todayYmd) > 0;

      HeatDayState state;
      double? dose;
      if (isFuture) {
        state = HeatDayState.future;
      } else if (row == null) {
        state = HeatDayState.absent;
      } else if (row.isUnknown) {
        state = HeatDayState.unknown;
      } else {
        dose = row.trainingDose;
        state = dose > 0 ? HeatDayState.active : HeatDayState.rest;
      }
      out.add(
        HeatCell(
          date: date,
          weekIdx: w,
          dayIdx: d,
          dose: dose,
          state: state,
          isToday: date == todayYmd,
        ),
      );
    }
  }
  return out;
}

/// 按列（周）重排热力图单元格，并在「周一首列跨月」时挂月份标签。
List<({int weekIdx, String month, List<HeatCell> cells})> buildHeatWeeks(
  List<HeatCell> cells,
) {
  final out = <({int weekIdx, String month, List<HeatCell> cells})>[];
  var lastMonth = '';
  final weekIndexes = cells.map((c) => c.weekIdx).toSet().toList()..sort();
  for (final w in weekIndexes) {
    final weekCells = cells.where((c) => c.weekIdx == w).toList();
    final month = weekCells.isEmpty ? '' : weekCells.first.date.substring(5, 7);
    final label = month != lastMonth ? '${int.parse(month)}月' : '';
    out.add((weekIdx: w, month: label, cells: weekCells));
    if (month.isNotEmpty) lastMonth = month;
  }
  return out;
}

// ── 8 周周剂量聚合（周一锚定周桶，unknown 周整周缺口）───────────────────────

class WeeklyDoseBucket {
  const WeeklyDoseBucket({
    required this.weekStart,
    required this.weekLabel,
    required this.totalDose,
    required this.activeDays,
  });

  final String weekStart;
  final String weekLabel; // 'M/D'
  final double? totalDose; // unknown 周 = null（缺口）
  final int activeDays;
}

List<WeeklyDoseBucket> aggregateWeeklyDose(
  List<StrideTrainingLoadRecord> records, {
  String? today,
}) {
  const weeks = 8;
  final todayYmd = today ?? shanghaiToday();
  final anchor = shanghaiYmdToEpoch(shanghaiWeekStart(todayYmd));
  final starts = [
    for (var i = weeks - 1; i >= 0; i--)
      epochToShanghaiYmd(anchor - i * 7 * 86400000),
  ];
  final totals = <String, double>{};
  final activeDays = <String, int>{};
  final unknownWeeks = <String>{};
  for (final r in records) {
    final weekStart = shanghaiWeekStart(r.date);
    if (!starts.contains(weekStart)) continue;
    if (r.isUnknown) {
      unknownWeeks.add(weekStart);
      continue;
    }
    totals[weekStart] = (totals[weekStart] ?? 0) + r.trainingDose;
    if (r.trainingDose > 0) {
      activeDays[weekStart] = (activeDays[weekStart] ?? 0) + 1;
    }
  }
  return [
    for (final s in starts)
      WeeklyDoseBucket(
        weekStart: s,
        weekLabel:
            '${int.parse(s.substring(5, 7))}/${int.parse(s.substring(8, 10))}',
        totalDose: unknownWeeks.contains(s)
            ? null
            : double.parse((totals[s] ?? 0).toStringAsFixed(1)),
        activeDays: activeDays[s] ?? 0,
      ),
  ];
}

// ── 每日活动摘要（热力图详情卡文案，同小程序/Web 口径）──────────────────────

const _sportNameCn = <(RegExp, String)>[
  (RegExp(r'run|treadmill', caseSensitive: false), '跑步'),
  (RegExp(r'strength|gym', caseSensitive: false), '力量训练'),
  (RegExp(r'bike|cycling', caseSensitive: false), '骑行'),
  (RegExp(r'swim', caseSensitive: false), '游泳'),
  (RegExp(r'walk', caseSensitive: false), '步行'),
  (RegExp(r'hike', caseSensitive: false), '徒步'),
  (RegExp(r'ski|snowboard', caseSensitive: false), '滑雪'),
  (RegExp(r'hiit', caseSensitive: false), 'HIIT'),
  (RegExp(r'row', caseSensitive: false), '划船'),
  (RegExp(r'jump rope', caseSensitive: false), '跳绳'),
  (RegExp(r'cardio', caseSensitive: false), '有氧'),
];

String chineseSportName(String? name) {
  final s = name ?? '';
  for (final (re, cn) in _sportNameCn) {
    if (re.hasMatch(s)) return cn;
  }
  return s.isEmpty ? '训练' : s;
}

/// 距离类运动展示「距离 + 配速 + 心率」；力量/HIIT 等只展示时长 + 心率。
bool isDistanceSport(String? name) => RegExp(
      r'run|bike|cycling|swim|walk|hike|treadmill|row',
      caseSensitive: false,
    ).hasMatch(name ?? '');

/// 秒 → `1h43min` / `43min` / `8h`（与 Web 端工具提示一致）。
String formatDurationHuman(num? seconds) {
  if (seconds == null || seconds <= 0) return '—';
  final total = seconds.round();
  final h = total ~/ 3600;
  final m = (total % 3600) ~/ 60;
  if (h > 0 && m > 0) return '${h}h${m}min';
  if (h > 0) return '${h}h';
  return '${m}min';
}
