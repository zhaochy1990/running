/// 上海时区日期工具 —— 移植自小程序 `utils/date.ts`（时区纪律的 canonical 实现）。
///
/// 用「UTC 时间戳 + 8h 偏移」手动算上海墙钟时间，避免 `DateTime.now()` 的本地
/// 字段（year/month/day）把 00:00-07:59 上海窗口错分到前一天。
///
/// 禁止模式：
///   DateTime.now().year / month / day 表示「今天」 → 用 shanghaiToday()
library;

const int _shanghaiOffsetMs = 8 * 60 * 60 * 1000; // UTC+8，无 DST
const int _dayMs = 24 * 60 * 60 * 1000;

String _pad2(int n) => n < 10 ? '0$n' : '$n';

/// epoch（UTC ms）→ 上海 YYYY-MM-DD
String epochToShanghaiYmd(int epochMs) {
  final d = DateTime.fromMillisecondsSinceEpoch(
    epochMs + _shanghaiOffsetMs,
    isUtc: true,
  );
  return '${d.year}-${_pad2(d.month)}-${_pad2(d.day)}';
}

/// epoch（UTC ms）→ 上海星期几（0=周日 … 6=周六）
int epochToShanghaiDow(int epochMs) {
  final d = DateTime.fromMillisecondsSinceEpoch(
    epochMs + _shanghaiOffsetMs,
    isUtc: true,
  );
  return d.weekday % 7; // Dart: Mon=1…Sun=7 → 0=Sun … 6=Sat
}

/// 上海 YYYY-MM-DD → epoch（UTC ms）。按上海 00:00 当作当天起点。
/// 非法输入抛 [FormatException]（不做静默回退，避免坏日期悄悄污染计算）。
int shanghaiYmdToEpoch(String ymd) {
  final m = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$').firstMatch(ymd);
  if (m == null) throw FormatException('invalid shanghai ymd: $ymd');
  return DateTime.utc(
    int.parse(m.group(1)!),
    int.parse(m.group(2)!),
    int.parse(m.group(3)!),
  ).millisecondsSinceEpoch -
      _shanghaiOffsetMs;
}

/// 今天（上海）YYYY-MM-DD。禁止用 `DateTime.now()` 的本地字段假设时区。
String shanghaiToday() => epochToShanghaiYmd(DateTime.now().millisecondsSinceEpoch);

int _shanghaiDowOfYmd(String ymd) => epochToShanghaiDow(shanghaiYmdToEpoch(ymd));

/// 按 dow（0=周日 … 6=周六）索引的中文星期标签。
const List<String> _cnWeekdaysByDow = [
  '周日',
  '周一',
  '周二',
  '周三',
  '周四',
  '周五',
  '周六',
];

/// 上海 YYYY-MM-DD → 中文星期（'周日' … '周六'）；非法输入返回 ''。
String shanghaiWeekdayLabel(String? ymd) {
  if (ymd == null || !RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(ymd)) return '';
  return _cnWeekdaysByDow[_shanghaiDowOfYmd(ymd)];
}

/// 给定上海 YYYY-MM-DD，返回该周周一（ISO 周起点）的 YYYY-MM-DD。
String shanghaiWeekStart(String ymd) {
  final dow = _shanghaiDowOfYmd(ymd); // 0=Sun … 6=Sat
  final daysBack = (dow + 6) % 7; // Mon=0, Tue=1, …, Sun=6
  return epochToShanghaiYmd(shanghaiYmdToEpoch(ymd) - daysBack * _dayMs);
}

/// 周目录名（后端 weekName 格式）：`YYYY-MM-DD_MM-DD`，起始为周一。
String weekFolderName(String weekStartYmd) {
  final endYmd = epochToShanghaiYmd(
    shanghaiYmdToEpoch(weekStartYmd) + 6 * _dayMs,
  );
  return '${weekStartYmd}_${endYmd.substring(5)}';
}

/// 一周的日期条（周一到周日，以 anchorYmd 所在周为基准）。
class WeekDay {
  const WeekDay({
    required this.date,
    required this.label,
    required this.dayNumber,
  });

  final String date; // YYYY-MM-DD
  final String label; // Mon … Sun
  final int dayNumber; // 日号
}

/// 展开以 [anchorYmd] 所在周为基准的周一到周日 7 天。
List<WeekDay> buildWeekDays(String anchorYmd) {
  final monday = shanghaiWeekStart(anchorYmd);
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  final base = shanghaiYmdToEpoch(monday);
  return [
    for (var i = 0; i < 7; i++)
      () {
        final date = epochToShanghaiYmd(base + i * _dayMs);
        return WeekDay(
          date: date,
          label: labels[i],
          dayNumber: int.parse(date.substring(8)),
        );
      }(),
  ];
}

/// 「(2026年7月)」样式的周副标题，基于周一的年月。
String weekSubtitle(String weekStartYmd) {
  final year = weekStartYmd.substring(0, 4);
  final month = int.parse(weekStartYmd.substring(5, 7));
  return '($year年$month月)';
}

/// 后端返回的活动 `date` 是上海 ISO 时间串（如 `2026-08-28T08:30:00+08:00`），
/// 也兼容 `YYYY-MM-DD`。取其上海日期部分 `YYYY-MM-DD`，非法则返回空串。
String shanghaiDateFromIso(String? iso) {
  if (iso == null || iso.isEmpty) return '';
  final datePart = iso.substring(0, 10);
  return RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(datePart) ? datePart : '';
}

/// 推送日期选项（今天起共 8 个可选日，含今天）。
class PushDateOption {
  const PushDateOption({required this.label, required this.value, this.selected});

  final String label;
  final String value; // YYYY-MM-DD
  final bool selected;
}

/// 生成推送日期选项 —— 从今天起往后（不出现今天以前的日期）。
/// 今天/明天/后天用中文标签，其他显示「周X MM/DD」。
/// 默认选中训练对应的计划日；计划日早于今天（任务已过期）时退回今天。
List<PushDateOption> buildPushDateOptions(String plannedDate) {
  const forwardDays = 7;
  final today = shanghaiToday();
  final todayEpoch = shanghaiYmdToEpoch(today);
  final plannedEpoch = shanghaiYmdToEpoch(plannedDate);
  final out = <PushDateOption>[];

  // 计划日落在今天（含）之后的可见范围内才提升为默认；否则回退今天。
  final plannedVisible = plannedEpoch >= todayEpoch;
  final defaultEpoch =
      plannedVisible && plannedEpoch <= todayEpoch + forwardDays * _dayMs
          ? plannedEpoch
          : todayEpoch;

  for (var i = 0; i <= forwardDays; i++) {
    final date = epochToShanghaiYmd(todayEpoch + i * _dayMs);

    var label;
    if (i == 0) {
      label = '今天';
    } else if (i == 1) {
      label = '明天';
    } else if (i == 2) {
      label = '后天';
    } else {
      final wd = shanghaiWeekdayLabel(date);
      final md = date.substring(5);
      label = '$wd $md';
    }

    if (date == plannedDate) {
      label = '$label（计划日）';
    }

    out.add(
      PushDateOption(
        label: label,
        value: date,
        selected: date == epochToShanghaiYmd(defaultEpoch),
      ),
    );
  }
  return out;
}
