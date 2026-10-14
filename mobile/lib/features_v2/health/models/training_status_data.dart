/// 训练状态页纯函数层 —— 移植自小程序 `utils/trainingStatus.ts`（#465）。
///
/// 与小程序 / Web 端保持同一套阈值与配色口径：
///   - Form/CTL 相对五档（绝对 TSB 口径已随 E2 删除废弃，#423 决议）
///   - readiness gate green/yellow/red + reasons 中文映射
///   - 16 周热力图分桶（0 / ≤40 / ≤80 / ≤120 / >120）
///   - 8 周周一锚定周剂量聚合（unknown 周整周置 null）
///
/// 不碰 Flutter 运行时（渲染在 training_status_screen.dart）。
library;

import 'dart:ui' show Color;

import '../../../data/models/training_status.dart';
import '../../../shared/utils/shanghai_date.dart';

const int dayMs = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Form zone —— 阈值按当日慢性负荷 (CTL) 比例划分（#423 五档表）
// ---------------------------------------------------------------------------

enum FormZone { overTaper, raceReady, transition, productive, overload }

const Map<FormZone, Color> formZoneColor = {
  FormZone.overTaper: Color(0xFFFFAB00), // 减量过多 >+.25
  FormZone.raceReady: Color(0xFF0097A7), // 比赛就绪 +.10~+.25
  FormZone.transition: Color(0xFF8888A0), // 维持期 ±.10
  FormZone.productive: Color(0xFF00A85A), // 提升期 −.25~−.10
  FormZone.overload: Color(0xFFD32F2F), // 过度负荷 <−.25
};

const Map<FormZone, String> formZoneLabel = {
  FormZone.overTaper: '减量过多',
  FormZone.raceReady: '比赛就绪',
  FormZone.transition: '维持期',
  FormZone.productive: '提升期',
  FormZone.overload: '过度负荷',
};

FormZone? classifyForm(num? form, num? chronic) {
  if (form == null || chronic == null || chronic <= 0) return null;
  final r = form / chronic;
  if (r > 0.25) return FormZone.overTaper;
  if (r >= 0.1) return FormZone.raceReady;
  if (r >= -0.1) return FormZone.transition;
  if (r >= -0.25) return FormZone.productive;
  return FormZone.overload;
}

Color formColorOf(num? form, num? chronic) =>
    formZoneColor[classifyForm(form, chronic) ?? FormZone.transition]!;

// ---------------------------------------------------------------------------
// readiness gate（green / yellow / red）
// ---------------------------------------------------------------------------

const Map<String, Color> readinessColorOf = {
  'green': Color(0xFF00A85A),
  'yellow': Color(0xFFE68A00),
  'red': Color(0xFFD32F2F),
};

const Map<String, String> _readinessLabel = {
  'green': '可进行强度训练',
  'yellow': '注意，建议减量',
  'red': '建议停训恢复',
};

const Map<String, String> _readinessGateLabel = {
  'green': '绿灯',
  'yellow': '黄灯',
  'red': '红灯',
};

/// readiness_reasons token → 中文（#423：修小程序英文 token 直显问题）。
const Map<String, String> readinessReasonZh = {
  'low_hrv': 'HRV 偏低',
  'rhr_elevated': '静息心率偏高',
  'sleep_debt': '睡眠欠债',
  'ok': '正常',
};

/// readiness 主色；未知 gate 归中性灰，避免异常值看起来像 STOP 信号。
Color readinessColor(String? gate) =>
    readinessColorOf[gate] ?? const Color(0xFF8888A0);

String readinessLabel(String? gate) =>
    gate != null ? (_readinessLabel[gate] ?? gate) : '—';

String readinessGateLabel(String? gate) =>
    gate != null ? (_readinessGateLabel[gate] ?? gate) : '—';

/// reasons token 列表 → 「 · 」连接的中文文案（未知 token 原样保留）。
String readinessReasonsText(List<String> reasons) => reasons
    .map((r) => readinessReasonZh[r] ?? r)
    .join(' · ');

/// 由负荷比（ACWR）衍生的训练状态分类。
String loadStateLabel(num? ratio) {
  if (ratio == null) return '—';
  if (ratio < 0.8) return '恢复期';
  if (ratio < 1.0) return '维持期';
  if (ratio < 1.3) return '提升期';
  return '过度负荷';
}

// ---------------------------------------------------------------------------
// 16 周训练热力图
// ---------------------------------------------------------------------------

/// 剂量分桶：0 空/休息，1–4 递增。
int heatmapBucket(num? dose) {
  if (dose == null || dose <= 0) return 0;
  if (dose <= 40) return 1;
  if (dose <= 80) return 2;
  if (dose <= 120) return 3;
  return 4;
}

/// 橙色渐变（0 = 休息中性底，1–4 = 强度递增），与小程序 HEATMAP_COLORS 一致。
const List<Color> heatmapColors = [
  Color(0x12FFFFFF), // 0 = 有记录但零剂量 / 休息（浅色主题下近透明的中性底）
  Color(0x40FF8F3C), // 1 = 轻（1–40）
  Color(0x80FF8F3C), // 2 = 中（41–80）
  Color(0xBFFF8F3C), // 3 = 重（81–120）
  Color(0xFFFF8F3C), // 4 = 最重（>120）
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

  /// 上海 YYYY-MM-DD。
  final String date;
  final int weekIdx; // 0..weeks-1
  final int dayIdx; // 0=Mon .. 6=Sun
  final double? dose;
  final HeatDayState state;
  final bool isToday;
}

/// 由 training-load series 构建 16 周热力图格子（周一起始，含未来日）。
List<HeatCell> buildHeatCells(
  List<TrainingLoadRecord> series, {
  int weeks = 16,
  String? today,
}) {
  final todayYmd = today ?? shanghaiToday();
  final seriesByDate = {for (final r in series) r.date: r};
  final thisMonday = shanghaiWeekStart(todayYmd);
  final firstMondayEpoch =
      shanghaiYmdToEpoch(thisMonday) - (weeks - 1) * 7 * dayMs;
  final out = <HeatCell>[];
  for (var w = 0; w < weeks; w++) {
    for (var d = 0; d < 7; d++) {
      final date = epochToShanghaiYmd(firstMondayEpoch + (w * 7 + d) * dayMs);
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
        dose = row.trainingDose?.toDouble();
        state = dose != null && dose > 0 ? HeatDayState.active : HeatDayState.rest;
      }
      out.add(HeatCell(
        date: date,
        weekIdx: w,
        dayIdx: d,
        dose: dose,
        state: state,
        isToday: date == todayYmd,
      ));
    }
  }
  return out;
}

/// 每列的月份标签（'' = 与前列同月不显示）。与小程序 buildHeatWeeks 的 month 一致。
List<String> heatMonthLabels(List<HeatCell> cells) {
  final labels = <String>[];
  var lastMonth = '';
  for (var w = 0; w < 16; w++) {
    final weekCells = cells.where((c) => c.weekIdx == w).toList();
    if (weekCells.isEmpty) {
      labels.add('');
      continue;
    }
    final month = weekCells.first.date.substring(5, 7);
    labels.add(month != lastMonth ? '${int.parse(month)}月' : '');
    lastMonth = month;
  }
  return labels;
}

// ---------------------------------------------------------------------------
// 8 周周剂量聚合 —— 与小程序 aggregateWeeklyDose 一致
// ---------------------------------------------------------------------------

class WeeklyDoseBucket {
  const WeeklyDoseBucket({
    required this.weekStart,
    required this.weekLabel,
    required this.totalDose,
    required this.activeDays,
  });

  final String weekStart;
  final String weekLabel; // 'M/D'
  final double? totalDose; // unknown 周 → null
  final int activeDays;
}

const int _weeklyDoseWeeks = 8;

/// 周一锚定周桶求和；coverage unknown 的整周置 null。
List<WeeklyDoseBucket> aggregateWeeklyDose(
  List<TrainingLoadRecord> records, {
  String? today,
}) {
  final todayYmd = today ?? shanghaiToday();
  final anchor = shanghaiYmdToEpoch(shanghaiWeekStart(todayYmd));
  final buckets = <String, ({double total, int days})>{};
  final unknownWeeks = <String>{};
  final orderedStarts = <String>[
    for (var i = _weeklyDoseWeeks - 1; i >= 0; i--)
      epochToShanghaiYmd(anchor - i * 7 * dayMs),
  ];

  for (final r in records) {
    final weekStart = shanghaiWeekStart(r.date);
    if (!orderedStarts.contains(weekStart)) continue;
    if (r.isUnknown) {
      unknownWeeks.add(weekStart);
      continue;
    }
    final dose = r.trainingDose;
    if (dose == null) continue;
    final prev = buckets[weekStart] ?? (total: 0.0, days: 0);
    buckets[weekStart] = (
      total: prev.total + dose.toDouble(),
      days: prev.days + (dose > 0 ? 1 : 0),
    );
  }

  // 与小程序一致：unknown 周整周 null（缺口）；无记录周也保持 null。
  return [
    for (final start in orderedStarts)
      () {
        final b = buckets[start];
        final unknown = unknownWeeks.contains(start);
        return WeeklyDoseBucket(
          weekStart: start,
          weekLabel:
              '${int.parse(start.substring(5, 7))}/${int.parse(start.substring(8, 10))}',
          totalDose: (unknown || b == null) ? null : b.total,
          activeDays: b?.days ?? 0,
        );
      }(),
  ];
}

// ---------------------------------------------------------------------------
// 每日活动摘要（热力图详情卡文案，与小程序 heatDetail 同口径）
// ---------------------------------------------------------------------------

final List<(RegExp, String)> _sportNameCn = [
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

/// 秒 → `1h43min` / `43min` / `8h`。
String formatDurationHuman(num? seconds) {
  if (seconds == null || seconds <= 0) return '—';
  final total = seconds.round();
  final h = total ~/ 3600;
  final m = (total % 3600) ~/ 60;
  if (h > 0 && m > 0) return '${h}h${m}min';
  if (h > 0) return '${h}h';
  return '${m}min';
}

// ---------------------------------------------------------------------------
// 通用格式化 / 边界
// ---------------------------------------------------------------------------

/// 上海日期 → `M/D` 短标签（兼容 YYYYMMDD）。
String formatDateShort(String ymd) {
  final d = ymd.length == 8
      ? '${ymd.substring(0, 4)}-${ymd.substring(4, 6)}-${ymd.substring(6, 8)}'
      : ymd;
  if (!RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(d)) return ymd;
  return '${int.parse(d.substring(5, 7))}/${int.parse(d.substring(8, 10))}';
}

/// 阈值配速秒/km → `M:SS/km`；非法 → '—'。
String fmtPace(num? secondsPerKm) {
  if (secondsPerKm == null || secondsPerKm <= 0) return '—';
  final s = secondsPerKm.round();
  return '${s ~/ 60}:${(s % 60).toString().padLeft(2, '0')}/km';
}

/// 图表 y 边界外扩 pad（相等时也保证高度）；非法输入回退 0..1。
({double min, double max}) padBounds(num? min, num? max, double pad) {
  if (min == null ||
      max == null ||
      min.isNaN ||
      max.isNaN ||
      !min.isFinite ||
      !max.isFinite) {
    return (min: 0.0, max: 1.0);
  }
  if (min == max) return (min: min - pad, max: max + pad);
  return (min: min - pad, max: max + pad);
}
