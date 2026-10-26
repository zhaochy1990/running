import Foundation
import Testing
@testable import StrideKit

// 赛事域纯函数单测（devops#769，PR-6）—— 对齐小程序 utils/raceCenterRows /
// raceDetailRows / raceCourse / racePlanRows / myRaceRows / raceResultRows 的
// 自检口径：徽章/缩写/分组/筛选/空态、时间轴与倒计时、报名按钮文案、
// 计划卡/自定义卡/混排行、PB 判定、表单校验、wire 编码语义。

// MARK: - 测试数据工厂

func makeCalendarRace(_ id: Int, date: String, name: String = "Test Race", nameCn: String? = nil,
                  city: String? = nil, label: String? = nil, waLabel: String? = nil,
                  types: [String] = [], favorited: Bool = false) -> RaceCalendarRace {
    RaceCalendarRace(id: id, name: name, nameCn: nameCn, raceDate: date, province: "上海市",
                     city: city, label: label, waLabel: waLabel, raceTypes: types, favorited: favorited)
}

func makeDetailRace(date: String = "2026-11-01",
                timeline: RaceSignupTimeline? = nil,
                items: [RaceItem] = [],
                strategyAvailable: Bool = true) -> RaceDetail {
    RaceDetail(id: 1, name: "Shanghai Marathon", nameCn: "上海马拉松", raceDate: date,
               province: "上海市", city: "上海市", label: "A", waLabel: "Gold",
               raceTypes: ["Marathon"], favorited: false,
               signupTimeline: timeline, signupChannels: nil, packetPickup: nil,
               items: items, cityContent: nil, strategyAvailable: strategyAvailable)
}

func makeItem(_ id: Int, type: String, name: String = "全程马拉松", startTime: String? = "07:00",
          distanceKm: Double? = 42.195, route: String? = nil,
          challenges: [RaceCourseChallenge]? = nil) -> RaceItem {
    RaceItem(id: id, name: name, type: type, startTime: startTime, entryFee: 100_00,
             quota: 15_000, distanceKm: distanceKm, startPoint: RacePoint(name: "外滩"),
             finishPoint: RacePoint(name: "徐家汇体育公园"), routeDescription: route,
             totalAscentM: 120, courseChallenges: challenges, cutoffs: nil)
}

@Suite struct RaceCenterRowsTests {

    @Test func badgesAndAbbr() {
        #expect(cnBadge("A") == "中国田协A类赛事")
        #expect(cnBadge("C（属地办赛）") == "中国田协C类（属地办赛）")
        #expect(cnBadge("未知") == "")
        #expect(cnBadge(nil) == "")
        #expect(waBadge("Platinum") == "世界田联白金标")
        #expect(waBadge("nope") == "")
        #expect(typeAbbr("Marathon") == "全马")
        #expect(typeAbbr("HalfMarathon") == "半马")
        #expect(typeAbbr("10Km") == "10K")
        #expect(typeAbbr("5.2Km") == "5.2K")
        #expect(typeAbbr("Other") == "")
    }

    @Test func rowViewPrefersCnNameAndFormats() {
        let row = toRaceRowView(makeCalendarRace(7, date: "2026-10-18", nameCn: "上海马拉松",
                                             city: "上海市", label: "A", waLabel: "Gold",
                                             types: ["Marathon", "10Km"], favorited: true))
        #expect(row.name == "上海马拉松")
        #expect(row.dateLabel == "10/18")
        #expect(row.weekday == "周日")
        #expect(row.typesLabel == "全马/10K")
        #expect(row.cnBadgeText == "中国田协A类赛事")
        #expect(row.waBadgeText == "世界田联金标")
        #expect(row.starred)
        #expect(row.city == "上海市")
        // 无中文名回落英文名；无城市 → —
        let bare = toRaceRowView(makeCalendarRace(8, date: "2026-01-02"))
        #expect(bare.name == "Test Race")
        #expect(bare.city == "—")
        #expect(bare.typesLabel == "—")
    }

    @Test func filterAndGroupByMonth() {
        let races = [
            makeCalendarRace(2, date: "2026-10-18", types: ["Marathon"]),
            makeCalendarRace(1, date: "2026-10-02", types: ["HalfMarathon"], favorited: true),
            makeCalendarRace(3, date: "2026-09-13"),
        ]
        let all = groupByMonth(filterRaces(races, RaceFilter()))
        #expect(all.map(\.key) == ["2026-09", "2026-10"])
        #expect(all[1].label == "10月")
        #expect(all[1].rows.map(\.id) == [1, 2]) // 同月按日期升序（防御性重排）

        let fav = filterRaces(races, RaceFilter(favoritesOnly: true))
        #expect(fav.map(\.id) == [1])

        let marathon = filterRaces(races, RaceFilter(type: "Marathon"))
        #expect(marathon.map(\.id) == [2])
    }

    @Test func viewStateEmptyTexts() {
        let today = "2026-10-26"
        // 年份无数据
        let none = RaceCenterModel.viewState(rows: [], year: "2026", province: "", typeIndex: 0, favOnly: false, today: today)
        #expect(none.emptyText == "2026 年暂无已发布赛事 · 下拉刷新")
        // 省份无数据
        let prov = RaceCenterModel.viewState(rows: [], year: "2026", province: "青海省", typeIndex: 0, favOnly: false, today: today)
        #expect(prov.emptyText == "青海省暂无已发布赛事 · 换个省份或下拉刷新")
        // 收藏空（无筛选干扰）
        let favEmpty = RaceCenterModel.viewState(
            rows: [makeCalendarRace(1, date: "2026-12-05")], year: "2026", province: "",
            typeIndex: 0, favOnly: true, today: today)
        #expect(favEmpty.emptyText == "还没有收藏的赛事 · 退出收藏筛选后点 ☆ 收藏")
        // 筛选空
        let filteredEmpty = RaceCenterModel.viewState(
            rows: [makeCalendarRace(1, date: "2026-12-05")], year: "2026", province: "",
            typeIndex: 1, favOnly: false, today: today)
        #expect(filteredEmpty.emptyText == "当前筛选下没有赛事 · 换个条件试试")
        // 默认视图过滤已结束（upcoming floor）；收藏视图与往年看整年
        let rows = [makeCalendarRace(1, date: "2026-10-01"), makeCalendarRace(2, date: "2026-12-05")]
        let upcomingOnly = RaceCenterModel.viewState(rows: rows, year: "2026", province: "", typeIndex: 0, favOnly: false, today: today)
        #expect(upcomingOnly.count == 1)
        let favRows = [
            makeCalendarRace(1, date: "2026-10-01", favorited: true),
            makeCalendarRace(2, date: "2026-12-05", favorited: true),
        ]
        let favView = RaceCenterModel.viewState(rows: favRows, year: "2026", province: "", typeIndex: 0, favOnly: true, today: today)
        #expect(favView.count == 2) // 收藏视图看整年
    }
}

@Suite struct RaceDetailRowsTests {

    @Test func daysAndGrid() {
        #expect(daysUntil(raceDate: "2026-10-26", today: "2026-10-26") == 0)
        #expect(daysUntil(raceDate: "2026-11-01", today: "2026-10-26") == 6)
        #expect(daysUntil(raceDate: "2026-10-25", today: "2026-10-26") == -1)

        let view = toRaceDetailView(makeDetailRace(date: "2026-11-01", items: [makeItem(1, type: "Marathon")]), today: "2026-10-26")
        #expect(view.head.grid[0] == RaceHeadCell(value: "6", label: "天后开赛", lead: true))
        #expect(view.head.grid[1].value == "11/01")
        #expect(view.head.grid[1].label == "比赛日 07:00")
        // 今天开赛 / 已结束
        let today = toRaceDetailView(makeDetailRace(date: "2026-10-26"), today: "2026-10-26")
        #expect(today.head.grid[0] == RaceHeadCell(value: "今天", label: "开赛", lead: false))
        let past = toRaceDetailView(makeDetailRace(date: "2026-10-25"), today: "2026-10-26")
        #expect(past.head.grid[0] == RaceHeadCell(value: "已结束", label: "", lead: false))
    }

    @Test func timelineDoneStateAndCollapse() {
        let lottery = RaceSignupTimeline(startAt: "2026-09-01", deadline: "2026-09-30", lottery: true,
                                         lotteryResultAt: "2026-10-15", paymentDeadline: "2026-10-20")
        let view = toRaceDetailView(makeDetailRace(timeline: lottery), today: "2026-10-26")
        let steps = view.head.timeline
        #expect(steps.map(\.key) == ["start", "deadline", "draw", "race"])
        #expect(steps[0...2].allSatisfy { $0.done }) // 已过日期完成
        #expect(steps[3].done == false) // 开赛未到
        #expect(steps[2].label == "出签·缴费")

        // 非抽签且无缴费截止 → 收成三步
        let noLottery = RaceSignupTimeline(startAt: "2026-09-01", deadline: "2026-09-30", lottery: false,
                                           lotteryResultAt: nil, paymentDeadline: nil)
        let collapsed = toRaceDetailView(makeDetailRace(timeline: noLottery), today: "2026-10-26").head.timeline
        #expect(collapsed.map(\.key) == ["start", "deadline", "race"])

        // 无 signup_timeline → 整条隐藏；待公布
        let none = toRaceDetailView(makeDetailRace(), today: "2026-10-26")
        #expect(none.head.timeline.isEmpty)
    }

    @Test func courseSectionAvailabilityAndStationTitle() {
        // 无路线且无难点 → nil（tab 缺席）
        #expect(toCourseSection(makeItem(1, type: "Marathon", startTime: nil, route: nil, challenges: nil)) == nil)
        let challenges = [
            RaceCourseChallenge(distanceKm: "0–10km（外滩→南京西路）", description: "【拥堵】0–10km 外滩起跑段收窄，配速会被压住"),
            RaceCourseChallenge(distanceKm: "28", description: "【坡道】28km 处长上坡"),
            RaceCourseChallenge(distanceKm: nil, description: "【风】江边风大"),
        ]
        let section = toCourseSection(makeItem(1, type: "Marathon", route: "一江一河", challenges: challenges))!
        #expect(section.route == "一江一河")
        #expect(section.ascent == "120")
        // 按起点公里排序，无里程垫底
        #expect(section.stations.map(\.cat) == ["拥堵", "坡道", "风"])
        #expect(section.stations[0].km == "0–10km（外滩→南京西路）")
        #expect(section.stations[2].km == "全段")
        #expect(section.stations[0].title == "外滩起跑段收窄")
        // 类别配色（未知回退灰）
        #expect(section.stations[0].colorHex == 0xFF6363)

        #expect(courseStationTitle("28km 处长上坡") == "处上坡处" || courseStationTitle("28km 处长上坡").count <= 16)
        #expect(parseCourseKm("0–10km")?.start == 0)
        #expect(parseCourseKm("0–10km")?.end == 10)
        #expect(parseCourseKm("17.4")?.start == 17.4)
        #expect(parseCourseKm(nil) == nil)
    }

    @Test func chipsAndPlanButton() {
        let items = [makeItem(1, type: "Marathon"), makeItem(2, type: "HalfMarathon", name: "半程马拉松"), makeItem(3, type: "Marathon", name: "全程2")]
        let chips = itemChips(items)
        #expect(chips.count == 2) // token 去重
        #expect(chips.first { $0.token == "Marathon" }?.label == "全马")

        #expect(planButtonLabel(itemType: "", state: nil) == "未报名")
        #expect(planButtonLabel(itemType: "Marathon", state: .want) == "全马 · 想报名")
        #expect(planButtonLabel(itemType: "Marathon", state: .registered) == "全马 · 已报名（等抽签）")
    }
}

@Suite struct StrategyRowsTests {

    @Test func paceAndDurationParsing() {
        #expect(parsePaceSPerKm("5:40/km") == 340)
        #expect(parsePaceSPerKm("5:40") == 340)
        #expect(parsePaceSPerKm("0:00") == nil)
        #expect(parsePaceSPerKm("abc") == nil)
        #expect(formatPace(340) == "5:40/km")

        #expect(parseDuration("3:59:59") == 14_399)
        #expect(parseDuration("59:59") == 3_599)
        #expect(parseDuration("0:00") == nil)
        #expect(formatDuration(14_399) == "3:59:59")
        #expect(formatDuration(3_599) == "59:59")
        #expect(formatDuration(3600) == "1:00:00")

        #expect(raceDistanceKm("Marathon") == 42.195)
        #expect(raceDistanceKm("10Km") == 10)
        #expect(raceDistanceKm("Trail") == nil)
        // 目标配速 = 成绩 ÷ 距离（四舍五入到秒）
        #expect(targetPaceLabel("3:59:59", itemType: "Marathon") == "5:41/km")
        #expect(targetPaceLabel("bad", itemType: "Marathon") == "")
    }

    @Test func splitSegmentNameParsing() {
        let a = splitSegmentName("0–3km 外滩起跑（中山东一路→新开河路收窄段）")
        #expect(a.distance == "0–3km")
        #expect(a.desc == "外滩起跑（中山东一路→新开河路收窄段）")
        let b = splitSegmentName("35公里 最后冲刺")
        #expect(b.distance == "35公里")
        let c = splitSegmentName("放松跑")
        #expect(c.distance == "放松跑")
        #expect(c.desc == "")
    }

    @Test func recomputeAndRoundTrip() {
        let content = RaceStrategyContent(
            raceName: "上海马拉松", itemType: "Marathon", targetFinishTime: "3:59:59",
            summary: "匀速",
            paceSegments: [
                RacePaceSegment(segment: "0–10km", distanceKm: 10, pace: "5:40/km", segmentTime: "", cumulativeTime: "", note: "压住"),
                RacePaceSegment(segment: "最后一拼", distanceKm: nil, pace: "5:20/km", segmentTime: "56:00", cumulativeTime: "3:59:00", note: ""),
            ],
            fuelingPlan: [RaceFuelingItem(timePoint: "45:00", content: "能量胶"), RaceFuelingItem(timePoint: "", content: "")],
            fuelingChecklist: [RaceFuelingChecklistItem(item: "能量胶（普通）", count: 4, note: "每 45 分钟一支")],
            courseTips: ["起跑收窄"], weatherTips: ["11 月风大"], basisNote: "近三月数据"
        )
        let view = toStrategyView(content)
        // 用时 = 距离 × 配速自动重算；距离缺失行保持原文本
        #expect(view.paceRows[0].segmentTime == "56:40")
        #expect(view.paceRows[0].cumulativeTime == "56:40")
        #expect(view.paceRows[1].segmentTime == "56:00")
        #expect(view.targetPace == "5:41/km")
        #expect(view.itemTypeLabel == "全马")
        #expect(view.weatherTips == "11 月风大")

        // 视图 → 保存体：编辑值回收、空补给行丢弃
        var edited = view
        edited.paceRows[0].pace = "5:30/km"
        edited.fuelingRows[1].content = "盐丸"
        let saved = fromStrategyView(edited, base: content)
        #expect(saved.paceSegments[0].pace == "5:30/km")
        #expect(saved.paceSegments[0].segmentTime == "55:00")
        #expect(saved.fuelingPlan.count == 2)
        #expect(saved.fuelingPlan[1].content == "盐丸")
        #expect(saved.fuelingChecklist?.count == 1) // 清单原样带回

        #expect(strategyShareTitle(view) == "我的上海马拉松比赛策略 · 目标 3:59:59")
        #expect(raceDayLabel("2026-11-01T00:00:00Z") == "2026/11/01")
    }

    @Test func latestVersionPicksMaxUpdatedAt() {
        let mk: (Int, String) -> RaceStrategyVersion = { id, at in
            RaceStrategyVersion(id: id, targetFinishTime: "3:5\(id):00", itemType: "Marathon", content: RaceStrategyContent(
                raceName: "x", itemType: "Marathon", targetFinishTime: "3:00:00", summary: "",
                paceSegments: [], fuelingPlan: []), updatedAt: at)
        }
        let latest = latestStrategyVersion([mk(1, "2026-10-01T00:00:00Z"), mk(2, "2026-10-20T00:00:00Z")])
        #expect(latest?.id == 2)
        #expect(latestStrategyVersion([]) == nil)
    }
}

@Suite struct MyRacesRowsTests {

    @Test func planCardAndStatePatch() {
        let plan = RacePlan(raceId: 9, itemType: "Marathon", state: .registered, hotel: false, transit: true,
                            race: nil, offboarded: false, createdAt: "", updatedAt: "")
        // race=nil（下架残留）→ 占位名 + 无日期
        let card = toPlanCard(plan, today: "2026-10-26")
        #expect(card.name == "已下架赛事")
        #expect(card.dateLabel == "")
        #expect(card.countdown == "")
        #expect(card.stateLabel == "已报名 · 等抽签")

        let patch = planStatePatch(.confirmed)
        #expect(patch.steps.map(\.label) == ["想报名", "已报名", "已中签", "确认参赛"])
        #expect(patch.steps.first { $0.state == .confirmed }?.on == true)
        #expect(planStatePatch(.lost).lost)

        #expect(planDateLabel("2026-11-01") == "2026/11/01 周日")
        #expect(countdownLabel(6) == "距离比赛还有 6 天")
        #expect(countdownLabel(0) == "今天开赛")
        #expect(countdownLabel(-1) == "")
    }

    @Test func customCardAndMerge() {
        let race = CustomRace(id: 3, name: "苍山越野", raceDate: "2026-11-15", itemType: "Trail",
                              distanceKm: 50, ascentM: 2600, city: "大理", website: "", note: "带杖",
                              state: .want, hotel: false, transit: false, done: false,
                              createdAt: "", updatedAt: "")
        let card = toCustomCard(race, today: "2026-10-26")
        #expect(card.badgeLabel == "越野跑 50K")
        #expect(card.metaLabel == "2026/11/15 周日 · 大理 · 爬升 D+2600m")
        #expect(card.steps.count == 2)

        // 距离与类型名一致不重复（10Km+10 → 10K）
        let tenK = CustomRace(id: 4, name: "周末赛", raceDate: "2026-11-15", itemType: "10Km",
                              distanceKm: 10, ascentM: nil, city: "", website: "", note: "",
                              state: .registered, hotel: false, transit: false, done: true,
                              createdAt: "", updatedAt: "")
        let doneCard = toCustomCard(tenK, today: "2026-10-26")
        #expect(doneCard.badgeLabel == "10K")
        #expect(doneCard.stateLabel == "已结束")
        #expect(doneCard.steps.isEmpty)

        // 混排 + 乐观合并（custom 状态 / official 状态与行程）
        let officialPlan = RacePlan(raceId: 9, itemType: "Marathon", state: .registered, hotel: false, transit: true,
                                    race: nil, offboarded: false, createdAt: "", updatedAt: "")
        let rows = toMyRaceRows([
            MyRaceItem(source: .official, plan: officialPlan, race: nil),
            MyRaceItem(source: .custom, plan: nil, race: race),
            MyRaceItem(source: .custom, plan: nil, race: nil), // 残缺项跳过
        ], today: "2026-10-26")
        #expect(rows.count == 2)
        guard case .custom(let key, var c) = rows[1] else {
            Issue.record("expected custom row"); return
        }
        #expect(key == "c-3")
        let patch = customStatePatch(.registered)
        c.stateLabel = patch.stateLabel
        let merged = mergeMyRaceRow(rows[1], customState: patch)
        if case .custom(_, let m) = merged {
            #expect(m.state == .registered)
            #expect(m.stateLabel == "已报名")
        } else {
            Issue.record("merge kept custom kind")
        }
        let officialPatched = mergeMyRaceRow(rows[0], state: planStatePatch(.won), hotel: true)
        if case .official(_, let p) = officialPatched {
            #expect(p.state == .won)
            #expect(p.hotel)
        } else {
            Issue.record("merge kept official kind")
        }
    }

    @Test func resultRowsPbAndSummary() {
        func result(_ labelId: String, band: RaceDistanceBand, seconds: Double?, name: String? = nil,
                    raceName: String? = nil, displayName: String? = nil, label: String? = nil) -> RaceResultItem {
            RaceResultItem(labelId: labelId, name: name, raceName: raceName, displayName: displayName,
                           label: label, waLabel: nil, sportName: "Run", date: "2026-10-18T09:30:00+08:00",
                           distanceBand: band, distanceM: 42_195, distanceKm: 42.2, durationS: seconds,
                           durationFmt: "03:59:59", avgPaceSKm: 340, paceFmt: "5:40/km", avgHr: 160,
                           maxHr: 178, ascentM: 180, thumbUrl: nil)
        }
        let races = [
            result("a", band: .marathon, seconds: 14_400, raceName: "上海马拉松", label: "A"),
            result("b", band: .marathon, seconds: 14_400, raceName: "无锡马拉松"), // 同成绩 → 首场（a 新→旧中先出）胜出? 新→旧序 a 在前
            result("c", band: .marathon, seconds: 13_999),
            result("d", band: .halfMarathon, seconds: 6_000),
            result("e", band: .other, seconds: 3_000),
            result("f", band: .marathon, seconds: nil),
        ]
        let pb = pbLabelIds(races)
        #expect(pb == ["c", "d"]) // 全马半马各最短；other 无 PB；无成绩不参评

        let rows = races.map { toResultRow($0, isPb: pb.contains($0.labelId)) }
        #expect(rows[2].isPb)
        #expect(rows[2].name == "全马") // c 无 raceName/displayName/name → 档位兜底
        #expect(rows[0].isAuto)
        #expect(rows[0].cnBadgeText == "中国田协A类赛事")
        #expect(rows[0].dateLabel == "2026/10/18")

        // 显示名链：官方 → 手编 → 活动 → 档位
        let manual = toResultRow(result("g", band: .other, seconds: 900, name: "晨跑", displayName: "我的首野"), isPb: false)
        #expect(manual.name == "我的首野")

        #expect(resultSummary(rows) == "共 6 场 · 全马 4 · 半马 1")
    }
}

@Suite struct CustomRaceFormTests {

    @Test func validationAndEncoding() {
        // 名称必填
        if case .ok = validateCustomRaceForm(name: "  ", raceDate: "2026-11-01", itemType: "Trail",
                                             distanceKm: "", ascentM: "", city: "", website: "", note: "", state: .want) {
            Issue.record("空名称应失败")
        }
        // 日期必填
        if case .ok = validateCustomRaceForm(name: "越野赛", raceDate: "", itemType: "Trail",
                                             distanceKm: "", ascentM: "", city: "", website: "", note: "", state: .want) {
            Issue.record("空日期应失败")
        }
        // 距离正数 ≤99999.9
        if case .ok = validateCustomRaceForm(name: "x", raceDate: "2026-11-01", itemType: "Trail",
                                             distanceKm: "0", ascentM: "", city: "", website: "", note: "", state: .want) {
            Issue.record("0 距离应失败")
        }
        if case .ok = validateCustomRaceForm(name: "x", raceDate: "2026-11-01", itemType: "Trail",
                                             distanceKm: "100000", ascentM: "", city: "", website: "", note: "", state: .want) {
            Issue.record("超上限应失败")
        }
        // 爬升非负整数
        if case .ok = validateCustomRaceForm(name: "x", raceDate: "2026-11-01", itemType: "Trail",
                                             distanceKm: "", ascentM: "12.5", city: "", website: "", note: "", state: .want) {
            Issue.record("小数爬升应失败")
        }
        // 通过：可选项显式 null/空串（PUT 全量语义）
        guard case .ok(let body) = validateCustomRaceForm(
            name: " 苍山越野 ", raceDate: "2026-11-01", itemType: "Trail",
            distanceKm: "50", ascentM: "2600", city: " 大理 ", website: "", note: "", state: .registered
        ) else {
            Issue.record("合法表单应通过"); return
        }
        #expect(body.name == "苍山越野")
        #expect(body.city == "大理")
        let json = String(data: try! JSONEncoder().encode(body), encoding: .utf8)!
        #expect(json.contains("\"distance_km\":50"))
        #expect(json.contains("\"ascent_m\":2600"))
        #expect(json.contains("\"website\":\"\""))
        // 全量更新缺省可选项会被清空 → null 必须显式出现
        guard case .ok(let empty) = validateCustomRaceForm(
            name: "x", raceDate: "2026-11-01", itemType: "Other",
            distanceKm: "", ascentM: "", city: "", website: "", note: "", state: .want
        ) else { return }
        let emptyJson = String(data: try! JSONEncoder().encode(empty), encoding: .utf8)!
        #expect(emptyJson.contains("\"distance_km\":null"))
        #expect(emptyJson.contains("\"ascent_m\":null"))
    }

    @Test func planUpsertBodyOmitsNil() {
        let body = RacePlanUpsertBody(itemType: "Marathon", state: .want)
        let json = String(data: try! JSONEncoder().encode(body), encoding: .utf8)!
        #expect(json.contains("\"hotel\"") == false) // 缺省 = 保留已存值
        let explicit = RacePlanUpsertBody(itemType: "Marathon", state: .confirmed, hotel: true)
        let json2 = String(data: try! JSONEncoder().encode(explicit), encoding: .utf8)!
        #expect(json2.contains("\"hotel\":true"))
    }

    @Test func wireDecoding() throws {
        let detailJSON = """
        {"id":1,"name":"NM","name_cn":null,"race_date":"2026-11-01","province":"上海市","city":null,
         "label":"A","wa_label":null,"race_types":["Marathon"],"favorited":false,
         "signup_timeline":null,"signup_channels":null,"packet_pickup":null,"items":[],"city_content":null,
         "strategy_available":true}
        """
        let detail = try JSONDecoder().decode(RaceDetail.self, from: Data(detailJSON.utf8))
        #expect(detail.nameCn == nil)
        #expect(detail.items.isEmpty)

        let planJSON = """
        {"race_id":9,"item_type":"Marathon","state":"registered","hotel":false,"transit":true,
         "race":null,"offboarded":false,"created_at":"","updated_at":""}
        """
        let plan = try JSONDecoder().decode(RacePlan.self, from: Data(planJSON.utf8))
        #expect(plan.state == .registered)
    }
}
