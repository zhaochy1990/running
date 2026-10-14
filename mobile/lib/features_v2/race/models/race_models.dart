/// Race domain DTOs — mirrors `src/go/internal/api` race projections
/// (race_catalog.go / race_favorites.go / race_plans.go / race_strategy.go /
/// races.go). Hand-written fromJson per plan O3 "hand-write everything".
library;

// ── Calendar ─────────────────────────────────────────────────────────────────

/// One race-center list row (userRaceSummaryDTO).
class RaceSummary {

  factory RaceSummary.fromJson(Map<String, dynamic> j) => RaceSummary(
        id: (j['id'] as num).toInt(),
        name: j['name'] as String? ?? '',
        nameCn: j['name_cn'] as String?,
        raceDate: j['race_date'] as String? ?? '',
        province: j['province'] as String?,
        city: j['city'] as String?,
        label: j['label'] as String?,
        waLabel: j['wa_label'] as String?,
        raceTypes:
            (j['race_types'] as List? ?? const []).cast<String>(),
        favorited: j['favorited'] as bool? ?? false,
      );
  const RaceSummary({
    required this.id,
    required this.name,
    this.nameCn,
    required this.raceDate,
    this.province,
    this.city,
    this.label,
    this.waLabel,
    required this.raceTypes,
    required this.favorited,
  });

  final int id;
  final String name;
  final String? nameCn;
  /// YYYY-MM-DD，无时间成分（时区纪律：不做 tz 转换）。
  final String raceDate;
  final String? province;
  final String? city;
  /// 田协认证（A/B/C/C（属地办赛）/系列赛），null=无。
  final String? label;
  /// 世界田联标牌（Platinum/Gold/Elite/Label），null=无。
  final String? waLabel;
  final List<String> raceTypes;
  final bool favorited;

  String get displayName => (nameCn?.isNotEmpty ?? false) ? nameCn! : name;

  RaceSummary copyWith({bool? favorited}) => RaceSummary(
        id: id,
        name: name,
        nameCn: nameCn,
        raceDate: raceDate,
        province: province,
        city: city,
        label: label,
        waLabel: waLabel,
        raceTypes: raceTypes,
        favorited: favorited ?? this.favorited,
      );
}

class RaceCalendarPage {

  factory RaceCalendarPage.fromJson(Map<String, dynamic> j) => RaceCalendarPage(
        races: (j['races'] as List? ?? const [])
            .cast<Map<String, dynamic>>()
            .map(RaceSummary.fromJson)
            .toList(growable: false),
        total: (j['total'] as num?)?.toInt() ?? 0,
      );
  const RaceCalendarPage({
    required this.races,
    required this.total,
  });

  final List<RaceSummary> races;
  final int total;
}

/// 报名时间轴（race_signup_timeline）。日期均为 YYYY-MM-DD 日历日期。
class RaceSignupTimeline {

  factory RaceSignupTimeline.fromJson(Map<String, dynamic> j) =>
      RaceSignupTimeline(
        startAt: j['start_at'] as String? ?? '',
        deadline: j['deadline'] as String? ?? '',
        lottery: j['lottery'] as bool? ?? false,
        lotteryResultAt: j['lottery_result_at'] as String?,
        paymentDeadline: j['payment_deadline'] as String?,
      );
  const RaceSignupTimeline({
    required this.startAt,
    required this.deadline,
    required this.lottery,
    this.lotteryResultAt,
    this.paymentDeadline,
  });

  final String startAt;
  final String deadline;
  final bool lottery;
  final String? lotteryResultAt;
  final String? paymentDeadline;
}

/// 报名渠道。urlType 空 = 无链接（公众号/站内渠道）。
class RaceSignupChannel {

  factory RaceSignupChannel.fromJson(Map<String, dynamic> j) =>
      RaceSignupChannel(
        name: j['name'] as String? ?? '',
        type: j['type'] as String? ?? '',
        url: j['url'] as String?,
        urlType: j['url_type'] as String? ?? '',
      );
  const RaceSignupChannel({
    required this.name,
    required this.type,
    this.url,
    required this.urlType,
  });

  final String name;
  final String type;
  final String? url;
  final String urlType;
}

class RacePacketPickup {

  factory RacePacketPickup.fromJson(Map<String, dynamic> j) =>
      RacePacketPickup(
        time: j['time'] as String? ?? '',
        location: j['location'] as String? ?? '',
      );
  const RacePacketPickup({required this.time, required this.location});

  final String time;
  final String location;
}

class RacePoint {

  factory RacePoint.fromJson(Map<String, dynamic> j) =>
      RacePoint(name: j['name'] as String? ?? '');
  const RacePoint({required this.name});

  final String name;
}

/// 详情页一个项目行（userRaceItemDTO）。entryFee 单位分。
class RaceItem {

  factory RaceItem.fromJson(Map<String, dynamic> j) => RaceItem(
        id: (j['id'] as num).toInt(),
        name: j['name'] as String? ?? '',
        type: j['type'] as String? ?? '',
        startTime: j['start_time'] as String?,
        entryFee: (j['entry_fee'] as num?)?.toInt(),
        quota: (j['quota'] as num?)?.toInt(),
        distanceKm: (j['distance_km'] as num?)?.toDouble(),
        startPoint: j['start_point'] == null
            ? null
            : RacePoint.fromJson(j['start_point'] as Map<String, dynamic>),
        finishPoint: j['finish_point'] == null
            ? null
            : RacePoint.fromJson(j['finish_point'] as Map<String, dynamic>),
        routeDescription: j['route_description'] as String?,
      );
  const RaceItem({
    required this.id,
    required this.name,
    required this.type,
    this.startTime,
    this.entryFee,
    this.quota,
    this.distanceKm,
    this.startPoint,
    this.finishPoint,
    this.routeDescription,
  });

  final int id;
  final String name;
  final String type;
  final String? startTime;
  final int? entryFee;
  final int? quota;
  final double? distanceKm;
  final RacePoint? startPoint;
  final RacePoint? finishPoint;
  final String? routeDescription;
}

class CityIntro {

  factory CityIntro.fromJson(Map<String, dynamic> j) => CityIntro(
        overview: j['overview'] as String? ?? '',
        culture: j['culture'] as String? ?? '',
        food: j['food'] as String? ?? '',
        history: j['history'] as String? ?? '',
      );
  const CityIntro({
    required this.overview,
    required this.culture,
    required this.food,
    required this.history,
  });

  final String overview;
  final String culture;
  final String food;
  final String history;
}

class CityAttraction {

  factory CityAttraction.fromJson(Map<String, dynamic> j) => CityAttraction(
        name: j['name'] as String? ?? '',
        description: j['description'] as String? ?? '',
      );
  const CityAttraction({required this.name, required this.description});

  final String name;
  final String description;
}

class RaceCityContent {

  factory RaceCityContent.fromJson(Map<String, dynamic> j) => RaceCityContent(
        city: j['city'] as String? ?? '',
        intro: j['intro'] == null
            ? null
            : CityIntro.fromJson(j['intro'] as Map<String, dynamic>),
        attractions: (j['attractions'] as List? ?? const [])
            .cast<Map<String, dynamic>>()
            .map(CityAttraction.fromJson)
            .toList(growable: false),
      );
  const RaceCityContent({
    required this.city,
    this.intro,
    required this.attractions,
  });

  final String city;
  final CityIntro? intro;
  final List<CityAttraction> attractions;
}

/// 详情页聚合（userRaceDetailDTO）。
class RaceDetail {

  factory RaceDetail.fromJson(Map<String, dynamic> j) => RaceDetail(
        id: (j['id'] as num).toInt(),
        name: j['name'] as String? ?? '',
        nameCn: j['name_cn'] as String?,
        raceDate: j['race_date'] as String? ?? '',
        province: j['province'] as String?,
        city: j['city'] as String?,
        label: j['label'] as String?,
        waLabel: j['wa_label'] as String?,
        raceTypes: (j['race_types'] as List? ?? const []).cast<String>(),
        favorited: j['favorited'] as bool? ?? false,
        signupTimeline: j['signup_timeline'] == null
            ? null
            : RaceSignupTimeline.fromJson(
                j['signup_timeline'] as Map<String, dynamic>),
        signupChannels: (j['signup_channels'] as List? ?? const [])
            .cast<Map<String, dynamic>>()
            .map(RaceSignupChannel.fromJson)
            .toList(growable: false),
        packetPickup: (j['packet_pickup'] as List? ?? const [])
            .cast<Map<String, dynamic>>()
            .map(RacePacketPickup.fromJson)
            .toList(growable: false),
        items: (j['items'] as List? ?? const [])
            .cast<Map<String, dynamic>>()
            .map(RaceItem.fromJson)
            .toList(growable: false),
        cityContent: j['city_content'] == null
            ? null
            : RaceCityContent.fromJson(j['city_content'] as Map<String, dynamic>),
        strategyAvailable: j['strategy_available'] as bool? ?? false,
      );
  const RaceDetail({
    required this.id,
    required this.name,
    this.nameCn,
    required this.raceDate,
    this.province,
    this.city,
    this.label,
    this.waLabel,
    required this.raceTypes,
    required this.favorited,
    this.signupTimeline,
    required this.signupChannels,
    required this.packetPickup,
    required this.items,
    this.cityContent,
    required this.strategyAvailable,
  });

  final int id;
  final String name;
  final String? nameCn;
  final String raceDate;
  final String? province;
  final String? city;
  final String? label;
  final String? waLabel;
  final List<String> raceTypes;
  final bool favorited;
  final RaceSignupTimeline? signupTimeline;
  final List<RaceSignupChannel> signupChannels;
  final List<RacePacketPickup> packetPickup;
  final List<RaceItem> items;
  final RaceCityContent? cityContent;
  final bool strategyAvailable;

  String get displayName => (nameCn?.isNotEmpty ?? false) ? nameCn! : name;
}

// ── Plans ────────────────────────────────────────────────────────────────────

class RacePlanRace {

  factory RacePlanRace.fromJson(Map<String, dynamic> j) => RacePlanRace(
        id: (j['id'] as num).toInt(),
        name: j['name'] as String? ?? '',
        nameCn: j['name_cn'] as String?,
        raceDate: j['race_date'] as String? ?? '',
        city: j['city'] as String?,
      );
  const RacePlanRace({
    required this.id,
    required this.name,
    this.nameCn,
    required this.raceDate,
    this.city,
  });

  final int id;
  final String name;
  final String? nameCn;
  final String raceDate;
  final String? city;

  String get displayName => (nameCn?.isNotEmpty ?? false) ? nameCn! : name;
}

/// 一条参赛计划（racePlanDTO）。lost 计划后端已过滤，不进响应。
class RacePlan {

  factory RacePlan.fromJson(Map<String, dynamic> j) => RacePlan(
        raceId: (j['race_id'] as num).toInt(),
        itemType: j['item_type'] as String? ?? '',
        state: j['state'] as String? ?? '',
        hotel: j['hotel'] as bool? ?? false,
        transit: j['transit'] as bool? ?? false,
        race: j['race'] == null
            ? null
            : RacePlanRace.fromJson(j['race'] as Map<String, dynamic>),
        offboarded: j['offboarded'] as bool? ?? false,
        updatedAt: j['updated_at'] as String? ?? '',
      );
  const RacePlan({
    required this.raceId,
    required this.itemType,
    required this.state,
    required this.hotel,
    required this.transit,
    this.race,
    required this.offboarded,
    required this.updatedAt,
  });

  final int raceId;
  final String itemType;
  /// want / registered / won / lost / confirmed。
  final String state;
  final bool hotel;
  final bool transit;
  final RacePlanRace? race;
  final bool offboarded;
  final String updatedAt;

  RacePlan copyWith({String? itemType, String? state, bool? hotel, bool? transit}) =>
      RacePlan(
        raceId: raceId,
        itemType: itemType ?? this.itemType,
        state: state ?? this.state,
        hotel: hotel ?? this.hotel,
        transit: transit ?? this.transit,
        race: race,
        offboarded: offboarded,
        updatedAt: updatedAt,
      );
}

// ── Strategies ───────────────────────────────────────────────────────────────

/// 一个目标版本（raceStrategyVersionDTO）。content 是 RaceStrategy 契约 JSON
/// （见 src/coach_contract/src/race_strategy/schema.ts），原样携带。
class RaceStrategyVersion {

  factory RaceStrategyVersion.fromJson(Map<String, dynamic> j) =>
      RaceStrategyVersion(
        id: (j['id'] as num).toInt(),
        targetFinishTime: j['target_finish_time'] as String? ?? '',
        itemType: j['item_type'] as String? ?? '',
        content: (j['content'] as Map?)?.cast<String, dynamic>() ?? const {},
        updatedAt: j['updated_at'] as String? ?? '',
      );
  const RaceStrategyVersion({
    required this.id,
    required this.targetFinishTime,
    required this.itemType,
    required this.content,
    required this.updatedAt,
  });

  final int id;
  /// 版本键 "H:MM:SS"。
  final String targetFinishTime;
  final String itemType;
  final Map<String, dynamic> content;
  /// RFC3339 UTC。
  final String updatedAt;
}

// ── Results ──────────────────────────────────────────────────────────────────

/// 一场已确认的比赛成绩（raceItemDTO，GET /api/{user}/races）。
/// date 为上海 ISO（Go API 已按上海时区序列化）。
class UserRace {

  factory UserRace.fromJson(Map<String, dynamic> j) => UserRace(
        labelId: j['label_id'] as String? ?? '',
        name: j['name'] as String?,
        date: j['date'] as String? ?? '',
        distanceBand: j['distance_band'] as String? ?? 'other',
        distanceKm: (j['distance_km'] as num?)?.toDouble() ?? 0,
        durationS: (j['duration_s'] as num?)?.toDouble(),
        durationFmt: j['duration_fmt'] as String? ?? '',
        paceFmt: j['pace_fmt'] as String? ?? '',
        avgHr: (j['avg_hr'] as num?)?.toInt(),
      );
  const UserRace({
    required this.labelId,
    this.name,
    required this.date,
    required this.distanceBand,
    required this.distanceKm,
    this.durationS,
    required this.durationFmt,
    required this.paceFmt,
    this.avgHr,
  });

  final String labelId;
  final String? name;
  final String date;
  /// marathon / half_marathon / other。
  final String distanceBand;
  final double distanceKm;
  final double? durationS;
  final String durationFmt;
  final String paceFmt;
  final int? avgHr;
}
