/// Activity 模型回归 —— 生产 Go DTO 的 sport_name 可为 null（#465 走查实测
/// 200/200 为 null），fromJson 必须回退空串而非抛 Null cast（否则记录页 /
/// 训练状态页的活动列表全挂）。
library;

import 'package:flutter_test/flutter_test.dart';

import 'package:stride/data/models/activity.dart';

void main() {
  test('sport_name null → 空串（生产 COROS 未命名活动）', () {
    final a = Activity.fromJson({
      'label_id': '481031113442099602',
      'sport_type': 100,
      'sport_name': null,
      'date': '2026-10-14T19:21:37.930000+08:00',
      'distance_m': 10592.14,
      'distance_km': 10.6,
      'duration_s': 3602,
      'duration_fmt': '01:00:02',
      'pace_fmt': '5:40/km',
    });
    expect(a.sportName, '');
    expect(a.paceFmt, '5:40/km');
  });

  test('sport_name 正常值原样保留', () {
    final a = Activity.fromJson({
      'label_id': 'x',
      'sport_type': 1,
      'sport_name': ' outdoor run ',
      'date': '2026-10-13T08:00:00+08:00',
      'distance_m': 5000,
      'distance_km': 5.0,
      'duration_s': 1800,
      'duration_fmt': '00:30:00',
      'pace_fmt': '6:00/km',
    });
    expect(a.sportName, ' outdoor run ');
  });
}
