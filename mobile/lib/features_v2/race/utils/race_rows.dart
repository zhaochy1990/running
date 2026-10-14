/// 赛事域纯视图模型 —— 从小程序同构层移植（utils/raceCenterRows.ts /
/// raceDetailRows.ts / raceStrategyRows.ts / racePlanRows.ts / my-races PB），
/// 语义与 #420 决议一致。配套 mobile/test/race_rows_test.dart 自检。
library;

import '../../../shared/utils/shanghai_date.dart';
import '../models/race_models.dart';

const int _dayMs = 24 * 60 * 60 * 1000;

// ── 徽章（#392）────────────────────────────────────────────────────────────

const Map<String, String> _cnLabelBadges = {
  'A': '中国田协A类赛事',
  'B': '中国田协B类赛事',
  'C': '中国田协C类赛事',
  'C（属地办赛）': '中国田协C类（属地办赛）',
  '系列赛': '中国田协系列赛',
};

const Map<String, String> _waLabelBadges = {
  'Gold': '世界田联金标',
  'Platinum': '世界田联白金标',
  'Label': '世界田联标牌',
  'Elite': '世界田联精英标',
};

/// 田协认证值 → 徽章全称；null 与未知取值返回 ''（不编造认证）。
String cnBadgeOf(String? label) =>
    label != null && _cnLabelBadges.containsKey(label) ? _cnLabelBadges[label]! : '';

/// 世界田联标牌值 → 徽章全称；null 与未知取值返回 ''。
String waBadgeOf(String? waLabel) =>
    waLabel != null && _waLabelBadges.containsKey(waLabel) ? _waLabelBadges[waLabel]! : '';

/// 项目 token → 密表缩写。{n}Km 压成 {n}K；未知 token 返回 ''。
String typeAbbr(String token) {
  if (token == 'Marathon') return '全马';
  if (token == 'HalfMarathon') return '半马';
  final m = RegExp(r'^(\d+(?:\.\d+)?)Km$').firstMatch(token);
  if (m != null) return '${m.group(1)}K';
  return '';
}

/// 千分位（en-US 口径，与小程序 toLocaleString('en-US') 一致）。
String formatCount(int n) {
  final s = '$n';
  final buf = StringBuffer();
  for (var i = 0; i < s.length; i++) {
    buf.write(s[i]);
    final rest = s.length - 1 - i;
    if (rest > 0 && rest % 3 == 0) buf.write(',');
  }
  return buf.toString();
}

// ── 日期 ─────────────────────────────────────────────────────────────────────

/// 距开赛天数：比赛日当天 = 0，已结束为负。入参均上海 YYYY-MM-DD。
int daysUntil(String raceDate, String today) =>
    ((shanghaiYmdToEpoch(raceDate) - shanghaiYmdToEpoch(today)) / _dayMs)
        .round();

/// 年份选项：当前上海年份 ±1。
List<String> raceYearOptions() {
  final y = int.parse(shanghaiToday().substring(0, 4));
  return ['${y - 1}', '$y', '${y + 1}'];
}

/// 省份筛选静态 34 省级行政区（口径与 race_calendar.province 一致，含后缀）。
const List<String> provinces = [
  '北京市', '上海市', '天津市', '重庆市', '河北省', '山西省', '辽宁省', '吉林省',
  '黑龙江省', '江苏省', '浙江省', '安徽省', '福建省', '江西省', '山东省', '河南省',
  '湖北省', '湖南省', '广东省', '海南省', '四川省', '贵州省', '云南省', '陕西省',
  '甘肃省', '青海省', '台湾省', '内蒙古自治区', '广西壮族自治区', '西藏自治区',
  '宁夏回族自治区', '新疆维吾尔自治区', '香港特别行政区', '澳门特别行政区',
];

// ── 密表行 / 分组 ────────────────────────────────────────────────────────────

/// 一行密表的渲染模型（全部字段预格式化，widget 不做表达式逻辑）。
class RaceRowView {
  const RaceRowView({
    required this.id,
    required this.dateLabel,
    required this.weekday,
    required this.name,
    required this.cnBadge,
    required this.waBadge,
    required this.typesLabel,
    required this.city,
    required this.starred,
  });

  final int id;
  final String dateLabel; // MM/DD
  final String weekday; // 周五
  final String name;
  final String cnBadge; // ''=隐藏
  final String waBadge; // ''=隐藏
  final String typesLabel; // 全马/半马；无已知项目 '—'
  final String city;
  final bool starred;
}

RaceRowView toRaceRowView(RaceSummary r) {
  final abbrs = r.raceTypes.map(typeAbbr).where((s) => s.isNotEmpty).toList();
  return RaceRowView(
    id: r.id,
    dateLabel: r.raceDate.length >= 10
        ? '${int.parse(r.raceDate.substring(5, 7))}/${int.parse(r.raceDate.substring(8, 10))}'
        : r.raceDate,
    weekday: shanghaiWeekdayLabel(r.raceDate),
    name: r.displayName,
    cnBadge: cnBadgeOf(r.label),
    waBadge: waBadgeOf(r.waLabel),
    typesLabel: abbrs.join('/') ,
    city: r.city ?? '—',
    starred: r.favorited,
  );
}

/// 月份分组（按比赛日升序防御性重排，API 本身有序）。
class RaceMonthGroup {
  const RaceMonthGroup({required this.key, required this.label, required this.rows});

  final String key; // YYYY-MM
  final String label; // 10月
  final List<RaceRowView> rows;
}

List<RaceMonthGroup> groupRacesByMonth(List<RaceSummary> races) {
  final sorted = [...races]..sort((a, b) {
      if (a.raceDate == b.raceDate) return a.id.compareTo(b.id);
      return a.raceDate.compareTo(b.raceDate);
    });
  final groups = <RaceMonthGroup>[];
  for (final r in sorted) {
    final ym = r.raceDate.length >= 7 ? r.raceDate.substring(0, 7) : '';
    final row = toRaceRowView(r);
    final last = groups.isEmpty ? null : groups.last;
    if (last == null || last.key != ym) {
      final month = ym.length == 7 ? int.parse(ym.substring(5, 7)) : 0;
      groups.add(RaceMonthGroup(
          key: ym, label: '$month月', rows: [row]));
    } else {
      groups[groups.length - 1] = RaceMonthGroup(
        key: last.key,
        label: last.label,
        rows: [...last.rows, row],
      );
    }
  }
  return groups;
}

/// 客户端筛选：type 匹配 race_types；favOnly 匹配收藏。
bool matchesRaceFilter(RaceSummary r, {required String type, required bool favoritesOnly}) {
  if (favoritesOnly && !r.favorited) return false;
  if (type.isNotEmpty && !r.raceTypes.contains(type)) return false;
  return true;
}

// ── 详情页视图模型（raceDetailRows.ts）─────────────────────────────────────

String _mdLabel(String? ymd) {
  if (ymd == null || !RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(ymd)) return '待公布';
  return '${int.parse(ymd.substring(5, 7))}/${int.parse(ymd.substring(8, 10))}';
}

class RaceHeadCell {
  const RaceHeadCell({required this.value, required this.label, required this.lead});
  final String value;
  final String label;
  final bool lead; // 仅未开赛的倒计时用强调色
}

class RaceTimelineStep {
  const RaceTimelineStep({required this.key, required this.date, required this.label, required this.done});
  final String key;
  final String date; // 'M/D' 或 '待公布'
  final String label;
  final bool done;
}

/// 各项目发枪时间里最早的一个（HH:MM 字典序即时间序）；没有 = ''。
String firstStartTime(List<RaceItem> items) {
  final times = items.map((it) => it.startTime).whereType<String>().where((t) => t.isNotEmpty).toList()
    ..sort();
  return times.isEmpty ? '' : times.first;
}

List<RaceHeadCell> raceHeadGrid(RaceDetail detail, String today) {
  final days = daysUntil(detail.raceDate, today);
  final countCell = days > 0
      ? RaceHeadCell(value: '$days', label: '天后开赛', lead: true)
      : days == 0
          ? const RaceHeadCell(value: '今天', label: '开赛', lead: false)
          : const RaceHeadCell(value: '已结束', label: '', lead: false);
  final start = firstStartTime(detail.items);
  final dayCell = RaceHeadCell(
    value: detail.raceDate.length >= 10 ? detail.raceDate.substring(5).replaceFirst('-', '/') : detail.raceDate,
    label: start.isNotEmpty ? '比赛日 $start' : '比赛日',
    lead: false,
  );
  final t = detail.signupTimeline;
  final format = t != null ? (t.lottery ? '抽签' : '先到先得') : '待定';
  return [countCell, dayCell, RaceHeadCell(value: format, label: '报名制式', lead: false)];
}

/// 时间轴：非抽签且无缴费截止时收成三步；done 按上海今天判定。
List<RaceTimelineStep> raceTimelineSteps(RaceDetail detail, String today) {
  final t = detail.signupTimeline;
  if (t == null) return const [];
  final drawAt = t.lotteryResultAt ?? t.paymentDeadline;
  final defs = <(String, String, String?)>[
    ('start', '报名开始', t.startAt),
    ('deadline', '报名截止', t.deadline),
    ('draw', t.lottery ? '出签·缴费' : '缴费截止', drawAt),
    ('race', '开赛', detail.raceDate),
  ];
  return defs
      .where((d) => d.$1 != 'draw' || t.lottery || (t.paymentDeadline ?? '').isNotEmpty)
      .map((d) {
    final ok = d.$3 != null && RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(d.$3!);
    return RaceTimelineStep(
      key: d.$1,
      label: d.$2,
      date: _mdLabel(d.$3),
      done: ok && d.$3!.compareTo(today) <= 0,
    );
  }).toList();
}

class RaceKvRow {
  const RaceKvRow(this.k, this.v);
  final String k;
  final String v;
}

/// 概要 kv（比赛日/起跑/地点/认证/项目/规模）。
List<RaceKvRow> raceSummaryRows(RaceDetail detail) {
  final weekday = shanghaiWeekdayLabel(detail.raceDate);
  final place = [detail.province, detail.city].whereType<String>().where((s) => s.isNotEmpty).join('');
  final startName = detail.items
      .map((it) => it.startPoint?.name)
      .whereType<String>()
      .where((s) => s.isNotEmpty)
      .firstOrNull;
  final placeLabel = [place, startName].where((s) => s != null && s.isNotEmpty).join(' · ');
  final badges = [cnBadgeOf(detail.label), waBadgeOf(detail.waLabel)]
      .where((s) => s.isNotEmpty)
      .toList();
  final quotas = detail.items.map((it) => it.quota).whereType<int>().where((q) => q > 0).toList();
  final scale = quotas.isEmpty ? '待定' : '${formatCount(quotas.reduce((a, b) => a + b))} 人';
  final start = firstStartTime(detail.items);
  return [
    RaceKvRow('比赛日', weekday.isNotEmpty ? '${detail.raceDate} $weekday' : detail.raceDate),
    RaceKvRow('起跑时间', start.isEmpty ? '待定' : start),
    RaceKvRow('地点', placeLabel.isEmpty ? '待定' : placeLabel),
    RaceKvRow('认证', badges.isEmpty ? '—' : badges.join(' · ')),
    RaceKvRow('项目', detail.items.isEmpty ? '—' : detail.items.map((it) => it.name).join(' / ')),
    RaceKvRow('规模', scale),
  ];
}

/// 报名费分 → 元标签；null/非正 = 待定。
String feeLabel(int? fen) {
  if (fen == null || fen <= 0) return '待定';
  final yuan = fen / 100;
  return yuan == yuan.roundToDouble() ? '¥${yuan.toInt()}' : '¥${yuan.toStringAsFixed(2)}';
}

class RaceItemSection {
  const RaceItemSection({required this.id, required this.title, required this.rows, required this.route});
  final int id;
  final String title;
  final List<RaceKvRow> rows;
  final String route; // ''=待补
}

List<RaceItemSection> raceItemSections(List<RaceItem> items) => items.map((it) {
      final ends = [it.startPoint?.name, it.finishPoint?.name]
          .whereType<String>()
          .where((s) => s.isNotEmpty)
          .toList();
      return RaceItemSection(
        id: it.id,
        title: it.name,
        rows: [
          RaceKvRow('距离', it.distanceKm != null ? '${it.distanceKm} km' : '待定'),
          RaceKvRow('名额', it.quota != null && it.quota! > 0 ? '${formatCount(it.quota!)} 人' : '待定'),
          RaceKvRow('起终点', ends.isEmpty ? '待定' : ends.join(' → ')),
          RaceKvRow('发枪', it.startTime ?? '待定'),
          RaceKvRow('报名费', feeLabel(it.entryFee)),
        ],
        route: it.routeDescription ?? '',
      );
    }).toList();

class RaceChannelRow {
  const RaceChannelRow({required this.key, required this.name, required this.type, required this.copyUrl});
  final String key;
  final String name;
  final String type;
  final String copyUrl; // ''=站内渠道
}

List<RaceChannelRow> raceChannelRows(List<RaceSignupChannel> channels) => [
      for (var i = 0; i < channels.length; i++)
        RaceChannelRow(
          key: '$i',
          name: channels[i].name,
          type: channels[i].type,
          copyUrl: channels[i].urlType == 'web' && (channels[i].url ?? '').isNotEmpty
              ? channels[i].url!
              : '',
        ),
    ];

// ── 报名选择器 ───────────────────────────────────────────────────────────────

/// 五态 + none（取消追踪）的中文标签。
const Map<String, String> planStateLabels = {
  'want': '想报名',
  'registered': '已报名（等抽签）',
  'won': '已中签',
  'lost': '未中签',
  'confirmed': '确认参赛',
};

/// 选择器状态选项：none = 未报名 · 取消追踪（删计划）。
const List<(String, String)> planStateOptions = [
  ('none', '未报名 · 取消追踪'),
  ('want', '想报名'),
  ('registered', '已报名（等抽签）'),
  ('won', '已中签'),
  ('lost', '未中签'),
  ('confirmed', '确认参赛'),
];

class RaceChip {
  const RaceChip({required this.token, required this.label});
  final String token;
  final String label;
}

/// 报名项目 chips：项目 type 去重；typeAbbr 不认识的 token 回落项目名。
List<RaceChip> raceItemChips(List<RaceItem> items) {
  final seen = <String, String>{};
  for (final it in items) {
    seen.putIfAbsent(it.type, () => typeAbbr(it.type).isNotEmpty ? typeAbbr(it.type) : it.name);
  }
  return [for (final e in seen.entries) RaceChip(token: e.key, label: e.value)];
}

/// 报名按钮文案：'未报名' 或 '全马 · 已报名（等抽签）'。
String planButtonLabel(String itemType, String state) {
  if (state.isEmpty || state == 'none') return '报名：未报名';
  return '报名：${typeAbbr(itemType).isNotEmpty ? typeAbbr(itemType) : itemType} · ${planStateLabels[state] ?? state}';
}

// ── 计划卡（racePlanRows.ts）────────────────────────────────────────────────

/// 状态条流转序列（lost 是旁路，不进 chips）。
const List<String> planStateFlow = ['want', 'registered', 'won', 'confirmed'];

class PlanStep {
  const PlanStep({required this.state, required this.label, required this.on});
  final String state;
  final String label;
  final bool on;
}

/// 状态徽章全称（卡头）；chips 用短名（去「 · 等抽签」尾缀）。
String planStateBadgeLabel(String state) => planStateLabels[state] ?? state;

List<PlanStep> planFlowSteps(String state) => [
      for (final s in planStateFlow)
        PlanStep(
          state: s,
          // chips 用短名：去「 · 等抽签」尾缀（racePlanRows 口径），兼容
          // 选择器全称的「（等抽签）」括号形态。
          label:
              (planStateLabels[s] ?? s).replaceAll(RegExp(r'\s*·\s*等抽签|（等抽签）'), ''),
          on: s == state,
        ),
    ];

String planDateLabel(String ymd) =>
    '${ymd.substring(0, 4)}/${ymd.substring(5).replaceFirst('-', '/')} ${shanghaiWeekdayLabel(ymd)}';

/// 倒计时文案；负数（已结束）不给文案。
String countdownLabel(int? days) {
  if (days == null || days < 0) return '';
  return days > 0 ? '距离比赛还有 $days 天' : '今天开赛';
}

// ── 成绩 tab ────────────────────────────────────────────────────────────────

String bandLabel(String band) {
  if (band == 'marathon') return '全马';
  if (band == 'half_marathon') return '半马';
  return '比赛';
}

/// PB 的 label_id 集合：全马/半马各自 duration_s 最短一场（`<=` 让新→旧遍历中
/// 同成绩的更旧一场胜出 → PB 记在首次跑出该成绩的那场）。other 不设 PB。
Set<String> pbLabelIds(List<UserRace> races) {
  final best = <String, (String, double)>{};
  for (final r in races) {
    final band = r.distanceBand;
    if (band != 'marathon' && band != 'half_marathon') continue;
    if (r.durationS == null) continue;
    final cur = best[band];
    if (cur == null || r.durationS! <= cur.$2) {
      best[band] = (r.labelId, r.durationS!);
    }
  }
  return best.values.map((e) => e.$1).toSet();
}

// ── 策略视图模型（raceStrategyRows.ts）─────────────────────────────────────

/// 配速文本 '5:40/km' → 每公里秒数；解析不了返回 null。
int? parsePaceSPerKm(String pace) {
  final m = RegExp(r'^(\d{1,2}):([0-5]\d)(?:\/\s*km)?$').firstMatch(pace.trim());
  if (m == null) return null;
  final sec = int.parse(m.group(1)!) * 60 + int.parse(m.group(2)!);
  return sec > 0 ? sec : null;
}

String formatPaceLabel(int sPerKm) {
  final m = sPerKm ~/ 60;
  final s = sPerKm % 60;
  return '$m:${s.toString().padLeft(2, '0')}/km';
}

/// 'h:mm:ss'（<1h 允许 'mm:ss'）→ 秒；解析不了返回 null。
int? parseDuration(String text) {
  final m = RegExp(r'^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$').firstMatch(text.trim());
  if (m == null) return null;
  final h = m.group(3) != null ? int.parse(m.group(1)!) : 0;
  final min = m.group(3) != null ? int.parse(m.group(2)!) : int.parse(m.group(1)!);
  final s = m.group(3) != null ? int.parse(m.group(3)!) : int.parse(m.group(2)!);
  final sec = h * 3600 + min * 60 + s;
  return sec > 0 ? sec : null;
}

String formatDuration(int sec) {
  final h = sec ~/ 3600;
  final m = (sec % 3600) ~/ 60;
  final s = sec % 60;
  final mm = m.toString().padLeft(2, '0');
  final ss = s.toString().padLeft(2, '0');
  return h > 0 ? '$h:$mm:$ss' : '$mm:$ss';
}

/// 项目 token → 标准距离 km；未知项目返回 null。
double? raceDistanceKm(String itemType) {
  if (itemType == 'Marathon') return 42.195;
  if (itemType == 'HalfMarathon') return 21.0975;
  final m = RegExp(r'^(\d+(?:\.\d+)?)Km$').firstMatch(itemType);
  return m != null ? double.parse(m.group(1)!) : null;
}

/// 目标配速 = 目标成绩 ÷ 项目距离（四舍五入到秒）；解析不了返回 ''。
String targetPaceLabel(String targetTime, String itemType) {
  final sec = parseDuration(targetTime);
  final km = raceDistanceKm(itemType);
  if (sec == null || km == null || km <= 0) return '';
  return formatPaceLabel((sec / km).round());
}

/// 可编辑配速行。
class PaceRow {
  PaceRow({
    required this.segment,
    required this.distance,
    required this.desc,
    required this.distanceKm,
    required this.pace,
    required this.segmentTime,
    required this.cumulativeTime,
    required this.note,
  });

  final String segment; // 原始分段名（保存体往返用）
  final String distance; // 距离短标签（'0–3km'），无前缀回落整段名
  final String desc; // 分段名去掉距离后的描述
  final double? distanceKm; // null=不自动换算
  String pace;
  String segmentTime;
  String cumulativeTime;
  String note;
}

/// 拆分段名：「0–3km 外滩起跑（…）」→ distance + desc；匹配不到回落整段名。
(String, String) splitSegmentName(String segment) {
  final m = RegExp(
    r'^([0-9]+(?:[.,][0-9]+)?\s*[–~\-—]+\s*[0-9]+(?:[.,][0-9]+)?\s*(?:km|公里)?|[0-9]+(?:[.,][0-9]+)?\s*(?:km|公里))\s*[：:、]?\s*(.*)$',
    caseSensitive: false,
  ).firstMatch(segment.trim());
  if (m == null) return (segment.trim(), '');
  return (m.group(1)!.replaceAll(RegExp(r'\s+'), ' ').trim(), m.group(2)!.trim());
}

/// 「用时=距离×配速」：逐行换算并累计；距离缺失或配速解析不了的行保持原文本。
void recomputePaceTimes(List<PaceRow> rows) {
  var cumulative = 0;
  for (final row in rows) {
    final pace = parsePaceSPerKm(row.pace);
    final km = row.distanceKm;
    if (km != null && km > 0 && pace != null) {
      final seg = (km * pace).round();
      cumulative += seg;
      row.segmentTime = formatDuration(seg);
      row.cumulativeTime = formatDuration(cumulative);
    }
  }
}

/// 策略 content → 可编辑行（自动换算后的分段表）。
List<PaceRow> paceRowsFromContent(Map<String, dynamic> content) {
  final segs = (content['pace_segments'] as List? ?? const []).cast<Map<String, dynamic>>();
  final rows = <PaceRow>[];
  for (final seg in segs) {
    final segment = seg['segment'] as String? ?? '';
    final (distance, desc) = splitSegmentName(segment);
    rows.add(PaceRow(
      segment: segment,
      distance: distance,
      desc: desc,
      distanceKm: (seg['distance_km'] as num?)?.toDouble(),
      pace: seg['pace'] as String? ?? '',
      segmentTime: seg['segment_time'] as String? ?? '',
      cumulativeTime: seg['cumulative_time'] as String? ?? '',
      note: seg['note'] as String? ?? '',
    ));
  }
  recomputePaceTimes(rows);
  return rows;
}

class FuelingRow {
  FuelingRow({required this.seq, required this.timePoint, required this.content});
  /// 稳定标识（增删后不变）：控制器池用它做 key，避免按 index 错位。
  int seq;
  String timePoint;
  String content;
}

List<FuelingRow> fuelingRowsFromContent(Map<String, dynamic> content) => [
      for (var i = 0;
          i < (content['fueling_plan'] as List? ?? const []).length;
          i++)
        () {
          final f = (content['fueling_plan'] as List).cast<Map<String, dynamic>>()[i];
          return FuelingRow(
            seq: i,
            timePoint: f['time_point'] as String? ?? '',
            content: f['content'] as String? ?? '',
          );
        }(),
    ];

/// 编辑值回收 → 保存体（目标/总述等文本字段原样带回；补给过滤全空白行）。
Map<String, dynamic> strategyContentForSave({
  required Map<String, dynamic> base,
  required List<PaceRow> paceRows,
  required List<FuelingRow> fuelingRows,
}) {
  recomputePaceTimes(paceRows);
  final out = Map<String, dynamic>.of(base);
  out['pace_segments'] = [
    for (final r in paceRows)
      {
        'segment': r.segment,
        'distance_km': r.distanceKm,
        'pace': r.pace,
        'segment_time': r.segmentTime,
        'cumulative_time': r.cumulativeTime,
        'note': r.note,
      },
  ];
  out['fueling_plan'] = [
    for (final f in fuelingRows)
      if (f.timePoint.trim().isNotEmpty || f.content.trim().isNotEmpty)
        {'time_point': f.timePoint.trim(), 'content': f.content.trim()},
  ];
  return out;
}
