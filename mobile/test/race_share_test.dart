// #424 决议 v1：详情页分享文本模板自检 —— 头行（🏃 名称 · MM/DD · 城市 ·
// 认证徽章）+ slogan + Landing 链接；缺失字段静默跳过、坏日期不编造。
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/features_v2/race/models/race_models.dart';
import 'package:stride/features_v2/race/utils/race_share.dart';

RaceDetail _detail({
  String date = '2026-03-22',
  String? city = '无锡',
  String? label,
  String? waLabel,
}) =>
    RaceDetail(
      id: 632,
      name: '2026无锡马拉松',
      raceDate: date,
      city: city,
      label: label,
      waLabel: waLabel,
      raceTypes: const [],
      favorited: false,
      signupChannels: const [],
      packetPickup: const [],
      items: const [],
      strategyAvailable: false,
    );

void main() {
  test('完整字段：头行四段 + slogan + Landing 链接', () {
    final text = raceShareText(_detail(
      label: 'A',
      waLabel: 'Gold',
    ));
    final lines = text.split('\n');
    expect(lines, hasLength(3));
    expect(lines[0], '🏃 2026无锡马拉松 · 03/22 · 无锡 · 中国田协A类赛事 · 世界田联金标');
    expect(lines[1], brandSlogan);
    expect(lines[2], brandLandingUrl);
    expect(brandLandingUrl, startsWith('https://'));
  });

  test('缺失城市/认证/日期：空段静默跳过', () {
    final text = raceShareText(_detail(date: '', city: null));
    expect(text.split('\n').first, '🏃 2026无锡马拉松');
  });

  test('坏日期格式不编造 MM/DD', () {
    final text = raceShareText(_detail(date: '待定'));
    expect(text.split('\n').first, isNot(contains('/')));
  });
}
