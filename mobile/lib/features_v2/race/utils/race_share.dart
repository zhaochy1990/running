/// 赛事详情分享文本模板 —— stride-devops#424 决议 v1：
/// `🏃 {赛事名} · {MM/DD} · {城市}{ · 认证徽章}` + 品牌 slogan + Landing 链接。
/// 系统分享（share_plus），落地品牌 Web Landing（App 无小程序卡片能力前的等价物）。
library;

import 'race_rows.dart';
import '../models/race_models.dart';

/// 品牌落地页（生产 Web Landing，stride-running.cn）。
const brandLandingUrl = 'https://stride-running.cn';

/// 品牌一句话 slogan（对齐小程序默认分享标题）。
const brandSlogan = '砺跑 STRIDE · 马拉松训练助手';

/// 缺失字段（无日期/城市/认证）静默跳过，不留空段。
String raceShareText(RaceDetail detail) {
  final head = [
    '🏃 ${detail.displayName}',
    if (_mmdd(detail.raceDate).isNotEmpty) _mmdd(detail.raceDate),
    if ((detail.city ?? '').isNotEmpty) detail.city!,
    ...[cnBadgeOf(detail.label), waBadgeOf(detail.waLabel)]
        .where((s) => s.isNotEmpty),
  ].join(' · ');
  return '$head\n$brandSlogan\n$brandLandingUrl';
}

/// '2026-03-22...' → '03/22'；非 ISO 日期前缀返回 ''（不编造）。
String _mmdd(String raceDate) {
  final m = RegExp(r'^(\d{4})-(\d{2})-(\d{2})').firstMatch(raceDate);
  if (m == null) return '';
  return '${m.group(2)}/${m.group(3)}';
}
