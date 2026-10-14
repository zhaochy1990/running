// 赛事域视图模型自检 —— 与小程序 utils/*.check.mts 同口径。
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/features_v2/race/models/race_models.dart';
import 'package:stride/features_v2/race/utils/race_rows.dart';
import 'package:stride/shared/utils/shanghai_date.dart';

void main() {
  group('badges', () {
    test('cn/wa badge mappings; unknown → empty (不编造认证)', () {
      expect(cnBadgeOf('A'), '中国田协A类赛事');
      expect(cnBadgeOf('C（属地办赛）'), '中国田协C类（属地办赛）');
      expect(cnBadgeOf('X'), '');
      expect(cnBadgeOf(null), '');
      expect(waBadgeOf('Gold'), '世界田联金标');
      expect(waBadgeOf('Platinum'), '世界田联白金标');
      expect(waBadgeOf('Elite'), '世界田联精英标');
      expect(waBadgeOf('silver'), '');
      expect(waBadgeOf(null), '');
    });

    test('typeAbbr', () {
      expect(typeAbbr('Marathon'), '全马');
      expect(typeAbbr('HalfMarathon'), '半马');
      expect(typeAbbr('10Km'), '10K');
      expect(typeAbbr('5.2Km'), '5.2K');
      expect(typeAbbr('Other'), '');
    });
  });

  group('dates', () {
    test('daysUntil', () {
      expect(daysUntil('2026-10-18', '2026-10-04'), 14);
      expect(daysUntil('2026-10-04', '2026-10-04'), 0);
      expect(daysUntil('2026-10-03', '2026-10-04'), -1);
    });

    test('raceYearOptions = 当前上海年 ±1', () {
      final y = int.parse(shanghaiTodayForTest().substring(0, 4));
      expect(raceYearOptions(), ['${y - 1}', '$y', '${y + 1}']);
    });
  });

  group('race center rows', () {
    test('toRaceRowView: name_cn 优先 / 双徽章 / typesLabel', () {
      final row = toRaceRowView(const RaceSummary(
        id: 74,
        name: '2026 Yellow River Estuary Marathon',
        nameCn: '2026黄河口（东营）马拉松',
        raceDate: '2026-10-18',
        city: '东营市',
        label: 'A',
        waLabel: 'Gold',
        raceTypes: ['Marathon', 'HalfMarathon'],
        favorited: false,
      ));
      expect(row.name, '2026黄河口（东营）马拉松');
      expect(row.dateLabel, '10/18');
      expect(row.weekday, '周日');
      expect(row.cnBadge, '中国田协A类赛事');
      expect(row.waBadge, '世界田联金标');
      expect(row.typesLabel, '全马/半马');
    });

    test('groupByMonth 升序分组 + 月标签', () {
      final groups = groupRacesByMonth([
        _race(2, '2026-11-01'),
        _race(1, '2026-10-18'),
        _race(3, '2026-10-25'),
      ]);
      expect(groups.map((g) => g.key).toList(), ['2026-10', '2026-11']);
      expect(groups.first.label, '10月');
      expect(groups.first.rows.map((r) => r.id), [1, 3]);
    });

    test('matchesRaceFilter：type 数组匹配 + 收藏过滤', () {
      final r = _race(1, '2026-10-18', types: ['Marathon'], fav: false);
      expect(matchesRaceFilter(r, type: 'Marathon', favoritesOnly: false), isTrue);
      expect(matchesRaceFilter(r, type: 'HalfMarathon', favoritesOnly: false), isFalse);
      expect(matchesRaceFilter(r, type: '', favoritesOnly: true), isFalse);
    });
  });

  group('detail view model', () {
    test('timeline：抽签四步 / 非抽签无缴费截止收三步 / done 按 today', () {
      RaceDetail detail({
        required bool lottery,
        String? paymentDeadline,
        String? lotteryResultAt,
      }) =>
          RaceDetail(
            id: 1,
            name: 'X',
            raceDate: '2026-10-18',
            raceTypes: const [],
            favorited: false,
            signupTimeline: RaceSignupTimeline(
              startAt: '2026-06-26',
              deadline: '2026-07-06',
              lottery: lottery,
              lotteryResultAt: lotteryResultAt,
              paymentDeadline: paymentDeadline,
            ),
            signupChannels: const [],
            packetPickup: const [],
            items: const [],
            strategyAvailable: false,
          );
      final d1 = detail(
          lottery: true, lotteryResultAt: '2026-07-12', paymentDeadline: '2026-07-16');
      final steps1 = raceTimelineSteps(d1, '2026-10-04');
      expect(steps1.map((s) => s.label).toList(),
          ['报名开始', '报名截止', '出签·缴费', '开赛']);
      expect(steps1.map((s) => s.done).toList(), [true, true, true, false]);
      expect(steps1[0].date, '6/26');

      final d2 = detail(lottery: false);
      expect(raceTimelineSteps(d2, '2026-10-04').map((s) => s.label).toList(),
          ['报名开始', '报名截止', '开赛']);
    });

    test('summary rows：规模求和 / 认证拼接 / 地点拼接', () {
      const detail = RaceDetail(
        id: 1,
        name: 'X',
        nameCn: '某马',
        raceDate: '2026-10-18',
        raceTypes: [],
        favorited: false,
        province: '山东省',
        city: '东营市',
        label: 'A',
        waLabel: 'Gold',
        signupChannels: [],
        packetPickup: [],
        items: [
          RaceItem(id: 1, name: '全程', type: 'Marathon', quota: 13000, startTime: '07:30'),
          RaceItem(id: 2, name: '半程', type: 'HalfMarathon', quota: 17000),
        ],
        strategyAvailable: false,
      );
      final rows = {for (final r in raceSummaryRows(detail)) r.k: r.v};
      expect(rows['规模'], '30,000 人');
      expect(rows['认证'], '中国田协A类赛事 · 世界田联金标');
      expect(rows['地点'], '山东省东营市');
      expect(rows['起跑时间'], '07:30');
    });

    test('feeLabel 分→元', () {
      expect(feeLabel(18000), '¥180');
      expect(feeLabel(15050), '¥150.50');
      expect(feeLabel(0), '待定');
      expect(feeLabel(null), '待定');
    });

    test('itemChips 按 type 去重', () {
      final chips = raceItemChips(const [
        RaceItem(id: 1, name: '全程', type: 'Marathon'),
        RaceItem(id: 2, name: '马拉松', type: 'Marathon'),
        RaceItem(id: 3, name: '半程', type: 'HalfMarathon'),
      ]);
      expect(chips.map((c) => c.token), ['Marathon', 'HalfMarathon']);
      expect(chips.first.label, '全马');
    });
  });

  group('strategy', () {
    test('parsePaceSPerKm / parseDuration / formatDuration / targetPaceLabel', () {
      expect(parsePaceSPerKm('4:55'), 295);
      expect(parsePaceSPerKm('4:55/km'), 295);
      expect(parsePaceSPerKm('0:00'), isNull);
      expect(parsePaceSPerKm('abc'), isNull);
      expect(parseDuration('3:15:00'), 11700);
      expect(parseDuration('56:40'), 3400);
      expect(formatDuration(3400), '56:40');
      expect(formatDuration(11700), '3:15:00');
      expect(targetPaceLabel('3:15:00', 'Marathon'), '4:37/km');
      // <1h 输入按 mm:ss 宽容解析（与小程序同口径）；版本键实际恒为 H:MM:SS。
      expect(parseDuration('3:15'), 195);
    });

    test('splitSegmentName 拆距离与描述', () {
      expect(splitSegmentName('0–3km 外滩起跑（中山东一路）'),
          ('0–3km', '外滩起跑（中山东一路）'));
      expect(splitSegmentName('5–10km'), ('5–10km', ''));
      expect(splitSegmentName('巡航段'), ('巡航段', ''));
    });

    test('recomputePaceTimes：seg=km×pace，cumulative 累加；缺距离不换算', () {
      final rows = [
        PaceRow(
          segment: '0–10km',
          distance: '0–10km',
          desc: '',
          distanceKm: 10,
          pace: '5:00',
          segmentTime: '',
          cumulativeTime: '',
          note: '',
        ),
        PaceRow(
          segment: '10–20km',
          distance: '10–20km',
          desc: '',
          distanceKm: 10,
          pace: '4:30',
          segmentTime: '',
          cumulativeTime: '',
          note: '',
        ),
        PaceRow(
          segment: '冲刺',
          distance: '冲刺',
          desc: '',
          distanceKm: null,
          pace: '4:00',
          segmentTime: 'keep',
          cumulativeTime: 'keep',
          note: '',
        ),
      ];
      recomputePaceTimes(rows);
      expect(rows[0].segmentTime, '50:00');
      expect(rows[0].cumulativeTime, '50:00');
      expect(rows[1].segmentTime, '45:00');
      expect(rows[1].cumulativeTime, '1:35:00');
      expect(rows[2].segmentTime, 'keep');
    });

    test('strategyContentForSave：往返 + 补给过滤全空白行', () {
      final base = <String, dynamic>{
        'race_name': 'X',
        'item_type': 'Marathon',
        'target_finish_time': '3:15:00',
        'summary': 's',
        'course_tips': <String>[],
        'weather_tips': <String>[],
        'basis_note': '',
      };
      final rows = [
        PaceRow(
          segment: '0–10km',
          distance: '0–10km',
          desc: '',
          distanceKm: 10,
          pace: '5:00',
          segmentTime: '',
          cumulativeTime: '',
          note: '稳住',
        ),
      ];
      final fueling = [
        FuelingRow(seq: 0, timePoint: '赛前 30 分钟', content: '能量胶'),
        FuelingRow(seq: 1, timePoint: '  ', content: ''),
      ];
      final out = strategyContentForSave(
          base: base, paceRows: rows, fuelingRows: fueling);
      final segs = out['pace_segments'] as List;
      final fuel = out['fueling_plan'] as List;
      expect(out['target_finish_time'], '3:15:00');
      expect((segs.first as Map)['segment_time'], '50:00');
      expect((segs.first as Map)['note'], '稳住');
      expect(fuel.length, 1);
    });
  });

  group('my races', () {
    test('planStateFlow 不含 lost；flow steps 短名', () {
      expect(planStateFlow.contains('lost'), isFalse);
      final steps = planFlowSteps('registered');
      expect(steps.map((s) => s.label), ['想报名', '已报名', '已中签', '确认参赛']);
      expect(steps.where((s) => s.on).single.state, 'registered');
    });

    test('countdownLabel / planDateLabel', () {
      expect(countdownLabel(14), '距离比赛还有 14 天');
      expect(countdownLabel(0), '今天开赛');
      expect(countdownLabel(-1), '');
      expect(planDateLabel('2026-11-01'), contains('2026/11/01'));
    });

    test('pbLabelIds：各档位最短，同成绩记更早一场；other 不设 PB', () {
      final races = [
        _userRace('new', 'marathon', 11273),
        _userRace('old', 'marathon', 11273),
        _userRace('slow', 'marathon', 11864),
        _userRace('half-pb', 'half_marathon', 5329),
        _userRace('half', 'half_marathon', 5515),
        _userRace('other', 'other', 100),
      ];
      expect(pbLabelIds(races), {'old', 'half-pb'});
    });

    test('bandLabel', () {
      expect(bandLabel('marathon'), '全马');
      expect(bandLabel('half_marathon'), '半马');
      expect(bandLabel('other'), '比赛');
    });
  });
}

RaceSummary _race(int id, String date,
        {List<String> types = const ['Marathon'], bool fav = false}) =>
    RaceSummary(
      id: id,
      name: 'R$id',
      raceDate: date,
      raceTypes: types,
      favorited: fav,
    );

UserRace _userRace(String labelId, String band, double durationS) => UserRace(
      labelId: labelId,
      date: '2026-09-27T10:00:00+08:00',
      distanceBand: band,
      distanceKm: 42.2,
      durationS: durationS,
      durationFmt: '3:07:53',
      paceFmt: '4:29',
    );

/// raceYearOptions 的测试锚点（与 utils 同源逻辑，避免测试耦合真实时钟）。
String shanghaiTodayForTest() {
  // 直接复用 utils 的 shanghaiToday（shared/utils/shanghai_date.dart）。
  return shanghaiToday();
}
