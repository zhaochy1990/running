/// 「今日」日视图模型 —— 移植自小程序 `services/plan.ts` 的 buildDayView。
///
/// 输入是结构化周课表（[WeeklyPlanDetail]），输出是展示就绪的
/// 训练卡 / 营养卡视图模型，供 /training 屏渲染。
library;

import '../../../data/models/weekly_plan.dart';
import '../../../shared/utils/shanghai_date.dart';

class ViewStat {
  const ViewStat({required this.value, required this.label});
  final String value;
  final String label;
}

class ViewIntensityBar {
  const ViewIntensityBar({required this.pct, required this.dim});
  final int pct; // 0-100，相对图表容器高度
  final bool dim; // 首段淡化（设计稿首段 60% 透明度）
}

class TodayWorkoutView {
  const TodayWorkoutView({
    required this.title,
    required this.sessionKind,
    required this.isRunning,
    required this.intensityBars,
    required this.stats,
    required this.coachNote,
    required this.sessionIndex,
    required this.date,
    required this.scheduledWorkoutId,
    required this.hasSpec,
  });

  final String title;
  final String sessionKind;
  final bool isRunning; // 仅 run 显示强度柱状图
  final List<ViewIntensityBar> intensityBars;
  final List<ViewStat> stats;
  final String coachNote; // 首行
  final int sessionIndex;
  final String date; // YYYY-MM-DD
  final int? scheduledWorkoutId; // null = 未推送
  final bool hasSpec; // 可推送到手表
}

class TodayMealView {
  const TodayMealView({
    required this.name,
    required this.timeHint,
    required this.detail,
    required this.kcal,
  });
  final String name;
  final String timeHint;
  final String detail;
  final String kcal;
}

class TodayNutritionView {
  const TodayNutritionView({
    required this.targetsTop,
    required this.targetsBottom,
    required this.hasTargets,
    required this.meals,
    required this.note,
  });

  final List<ViewStat> targetsTop;
  final List<ViewStat> targetsBottom;
  final bool hasTargets;
  final List<TodayMealView> meals;
  final String note;
}

class DayView {
  const DayView({
    required this.weekDays,
    required this.subtitle,
    required this.dayLabel,
    required this.workout,
    required this.nutrition,
  });

  final List<WeekDay> weekDays;
  final String subtitle; // 「(2026年10月)」
  final String dayLabel; // 「10月9日」
  final TodayWorkoutView? workout;
  final TodayNutritionView? nutrition;
}

// ── 格式化（对齐小程序 utils/format.ts）────────────────────────────────────

/// 米 → 公里字符串（保留 2 位小数）。null/非法 → '—'。
String fmtKm(num? meters) {
  if (meters == null || meters <= 0) return '—';
  return (meters / 1000).toStringAsFixed(2);
}

/// 秒 → `H:MM:SS`（各段两位补零）。null/非法 → '—'。
String fmtHms(num? seconds) {
  if (seconds == null || seconds <= 0) return '—';
  final total = seconds.round();
  final h = total ~/ 3600;
  final m = (total % 3600) ~/ 60;
  final s = total % 60;
  final mm = m.toString().padLeft(2, '0');
  final ss = s.toString().padLeft(2, '0');
  final hh = h.toString().padLeft(2, '0');
  return '$hh:$mm:$ss';
}

/// 自然时长：1 小时内 `M:SS`，超过则 `H:MM:SS`。
String fmtDurationShort(num? seconds) {
  if (seconds == null || seconds <= 0) return '—';
  final total = seconds.round();
  final h = total ~/ 3600;
  final m = (total % 3600) ~/ 60;
  final s = total % 60;
  final ss = s.toString().padLeft(2, '0');
  if (h > 0) return '$h:${m.toString().padLeft(2, '0')}:$ss';
  return '$m:$ss';
}

String _integerOrDash(num? value) {
  if (value == null) return '—';
  return value.round().toString();
}

String? firstLine(String? text) {
  if (text == null) return null;
  for (final line in text.split('\n')) {
    final t = line.trim();
    if (t.isNotEmpty) {
      return t.length > 200 ? '${t.substring(0, 200)}…' : t;
    }
  }
  return null;
}

// ── 组装 ─────────────────────────────────────────────────────────────────────

/// 组装指定日期（上海 YYYY-MM-DD）的视图模型。无训练/营养时对应字段为 null。
DayView buildDayView(WeeklyPlanDetail? plan, String dateYmd) {
  final weekStart = shanghaiWeekStart(dateYmd);
  final content = plan?.content;

  // 当日课节：优先可推送的（run/strength），其次任意非 rest/note。
  PlannedSession? workoutSession;
  if (content != null) {
    final daySessions = content.sessionsOn(dateYmd);
    workoutSession =
        daySessions.where((s) => s.kind == 'run' || s.kind == 'strength').firstOrNull ??
            daySessions
                .where((s) => s.kind != 'rest' && s.kind != 'note')
                .firstOrNull;
  }

  final nutrition = content?.nutritionOn(dateYmd);

  return DayView(
    weekDays: buildWeekDays(dateYmd),
    subtitle: weekSubtitle(weekStart),
    dayLabel:
        '${int.parse(dateYmd.substring(5, 7))}月${int.parse(dateYmd.substring(8))}日',
    workout: _buildWorkoutView(workoutSession, content),
    nutrition: _buildNutritionView(nutrition),
  );
}

TodayWorkoutView? _buildWorkoutView(
  PlannedSession? session,
  WeeklyPlanContent? content,
) {
  if (session == null) return null;

  final spec = session.spec;
  final runSpec = spec is RunWorkoutSpec ? spec : null;
  final isRunning = session.kind == 'run' && runSpec != null;

  final title = session.displayName ?? '训练';
  final coachNote = firstLine(session.notesMd) ??
      firstLine(content?.coachNotes) ??
      firstLine(content?.notesMd) ??
      '';

  return TodayWorkoutView(
    title: title,
    sessionKind: session.kind,
    isRunning: isRunning,
    intensityBars: isRunning ? _deriveIntensityBars(runSpec.blocks) : const [],
    stats: [
      ViewStat(value: fmtKm(session.totalDistanceM), label: '距离(公里)'),
      ViewStat(value: fmtHms(session.totalDurationS), label: '总时长'),
      const ViewStat(value: '—', label: '训练负荷'),
    ],
    coachNote: coachNote,
    sessionIndex: session.sessionIndex,
    date: session.date,
    scheduledWorkoutId: session.scheduledWorkoutId,
    hasSpec: session.pushable,
  );
}

TodayNutritionView? _buildNutritionView(PlannedNutrition? nutrition) {
  if (nutrition == null) return null;

  final targetsTop = [
    ViewStat(value: _integerOrDash(nutrition.kcalTarget), label: '目标热量(kcal)'),
    ViewStat(value: _integerOrDash(nutrition.carbsG), label: '碳水(g)'),
    ViewStat(value: _integerOrDash(nutrition.proteinG), label: '蛋白质(g)'),
  ];
  final targetsBottom = [
    ViewStat(value: _integerOrDash(nutrition.fatG), label: '脂肪(g)'),
    ViewStat(value: _integerOrDash(nutrition.waterMl), label: '饮水(ml)'),
  ];
  final meals = nutrition.meals
      .map((m) => TodayMealView(
            name: m.name,
            timeHint: m.timeHint ?? '',
            detail: firstLine(m.itemsMd) ?? '',
            kcal: m.kcal != null ? '${m.kcal!.round()} kcal' : '—',
          ))
      .toList();

  final note = firstLine(nutrition.notesMd) ?? '';
  final hasTargets =
      [...targetsTop, ...targetsBottom].any((t) => t.value != '—');

  // 无目标值、无餐次、且无建议 = 当天没有饮食安排，整块隐藏（空态也不展示）。
  if (meals.isEmpty && !hasTargets && note.isEmpty) return null;

  return TodayNutritionView(
    targetsTop: targetsTop,
    targetsBottom: targetsBottom,
    hasTargets: hasTargets,
    meals: meals,
    note: note,
  );
}

// ── 强度柱状图启发式（对齐小程序 deriveIntensityBars）────────────────────────

/// 由跑课 blocks 生成强度柱（0-100 高度）。warmup/recovery/cooldown/rest 给
/// 固定低强度，work 段按目标心率/配速映射到 60-95。首段淡化。最多 12 根。
List<ViewIntensityBar> _deriveIntensityBars(List<WorkoutBlock> blocks) {
  final raw = <int>[];
  for (final block in blocks) {
    for (var r = 0; r < (block.repeat < 1 ? 1 : block.repeat); r++) {
      for (final step in block.steps) {
        raw.add(_stepIntensity(step));
      }
    }
  }
  if (raw.isEmpty) return const [];
  final sampled = raw.length > 12 ? _sampleEvenly(raw, 12) : raw;
  return [
    for (var i = 0; i < sampled.length; i++)
      ViewIntensityBar(pct: sampled[i], dim: i == 0),
  ];
}

int _stepIntensity(WorkoutStep step) {
  switch (step.stepKind) {
    case 'rest':
      return 10;
    case 'cooldown':
      return 25;
    case 'warmup':
      return 35;
    case 'recovery':
      return 45;
  }

  // work（或未知类型）：按目标区间映射
  final target = step.target;
  if (target.kind == 'hr_bpm') {
    final high = (target.high ?? target.low)?.toInt();
    if (high == null) return 75;
    if (high >= 175) return 95;
    if (high >= 165) return 85;
    if (high >= 150) return 75;
    return 65;
  }
  if (target.kind == 'pace_s_km') {
    final low = (target.low ?? target.high)?.toInt(); // 更快 = 更小秒值 = 更高强度
    if (low == null) return 75;
    if (low <= 240) return 95;
    if (low <= 300) return 85;
    if (low <= 360) return 75;
    return 65;
  }
  return 75;
}

List<int> _sampleEvenly(List<int> arr, int count) {
  return [
    for (var i = 0; i < count; i++)
      arr[((i * (arr.length - 1)) / (count - 1)).round()],
  ];
}
