import Foundation
import Observation

// 训练状态页 ViewModel（devops#768 PR-5，baseline §4.3 直译）：
// 四指标卡 / readiness 条 / 负荷 6 格 / 窗口 segmented / 六图（RHR·HRV 带
// 区间带、日剂量、慢急双折线、Form 五区柱、周剂量）/ 16 周热力图（点格展开
// 当日详情）。5 端点并行 + 活动 200/页循环拉满 16 周；数据不足逐块隐藏。

// MARK: - 图表数据点

public struct TrendPoint: Equatable, Identifiable, Sendable {
    public let x: Double
    public let y: Double?
    public let label: String
    /// Form 柱的逐点配色。
    public let color: UInt32?

    public var id: String { label }
}

public struct MetricCardVM: Equatable, Identifiable, Sendable {
    public let label: String
    public let sub: String
    public let value: String
    public let unit: String
    public let baseline: String
    public let color: UInt32

    public var id: String { label }
}

public struct LoadStatVM: Equatable, Identifiable, Sendable {
    public let label: String
    public let value: String
    public let color: UInt32

    public var id: String { label }
}

public struct HeatDayDetail: Equatable, Sendable {
    public let date: String
    public let title: String
    public let dose: String
    public let lines: [String]
}

// MARK: - ViewModel

@MainActor
@Observable
public final class TrainingStatusModel {

    public static let trendWindows = [14, 30, 60, 90]
    /// 活动分页步长（服务端 limit 上限 200）。
    static let activitiesPageSize = 200
    /// 热力图窗口（16 周）。
    static let heatWeeks = 16

    public private(set) var loading = true
    public private(set) var errorText = ""
    public private(set) var metrics: [MetricCardVM] = []
    public private(set) var loadStats: [LoadStatVM] = []
    public private(set) var readinessLabel = ""
    public private(set) var readinessColor: UInt32 = 0x8888A0
    public private(set) var readinessReasons = ""
    public private(set) var hasLoad = false
    public private(set) var trendDays = 30
    public private(set) var hasRhrChart = false
    public private(set) var rhrSeries: [TrendPoint] = []
    public private(set) var rhrBaseline: Double?
    public private(set) var hasHrvChart = false
    public private(set) var hrvSeries: [TrendPoint] = []
    public private(set) var hrvBand: (low: Double, high: Double)?
    public private(set) var hasDoseChart = false
    public private(set) var doseSeries: [TrendPoint] = []
    public private(set) var hasLoadChart = false
    public private(set) var chronicSeries: [TrendPoint] = []
    public private(set) var acuteSeries: [TrendPoint] = []
    public private(set) var hasFormChart = false
    public private(set) var formSeries: [TrendPoint] = []
    public private(set) var hasWeekChart = false
    public private(set) var weekSeries: [TrendPoint] = []
    public private(set) var heatWeeks: [HeatWeek] = []
    public private(set) var heatSelected: HeatDayDetail?
    public private(set) var currentCtlNote = ""
    public private(set) var calibrationLine = "Calibration: — · 来源：STRIDE 自研算法"
    public private(set) var loadDateLine = "Training load latest: —"

    private var healthData: HealthResponse?
    private var hrvData: HrvResponse?
    private var zonesData: StrideZonesResponse?
    private var loadData: StrideTrainingLoadResponse?
    private var activitiesByDate: [String: [Activity]] = [:]
    private let todayYmd: String
    private var repo: TrainingRepository?
    private var activitiesRepo: ActivitiesRepository?
    private var userId = ""
    private var started = false

    public init(now: Date = Date()) {
        todayYmd = Shanghai.todayYMD(now: now)
    }

    public func activate(app: AppModel) async {
        guard !started else { return }
        started = true
        await app.waitUntilSessionSettled()
        repo = TrainingRepository(api: app.api)
        activitiesRepo = ActivitiesRepository(api: app.api)
        userId = app.me?.id ?? ""
        guard !userId.isEmpty else {
            loading = false
            return
        }
        await fetch()
    }

    public func retry() async {
        await fetch()
    }

    // MARK: - 拉取（5 端点并行 + 活动分页拉满）

    private func fetch() async {
        loading = true
        errorText = ""
        do {
            async let healthTask = repo?.health(userId: userId, days: 90)
            async let hrvTask = repo?.hrv(userId: userId, days: 90)
            async let zonesTask = repo?.strideZones(userId: userId)
            async let loadTask = repo?.trainingLoad(userId: userId, days: 112)
            async let actsTask = fetchAllActivities()
            let (h, hv, z, ld, acts) = try await (healthTask, hrvTask, zonesTask, loadTask, actsTask)
            healthData = h ?? nil
            hrvData = hv ?? nil
            zonesData = z ?? nil
            loadData = ld ?? nil
            activitiesByDate = Dictionary(grouping: acts, by: { String($0.date.prefix(10)) })
            loading = false
            render()
        } catch {
            loading = false
            errorText = "加载失败，请稍后重试"
        }
    }

    /// 分页拉取 16 周窗口内的全部活动（limit 200/页，按 total 终止）。
    private func fetchAllActivities() async throws -> [Activity] {
        guard let activitiesRepo else { return [] }
        let from = Shanghai.addDays(todayYmd, -Self.heatWeeks * 7)
        var all: [Activity] = []
        var offset = 0
        while true {
            let page = try await activitiesRepo.list(
                userId: userId, dateFrom: from, dateTo: todayYmd,
                limit: Self.activitiesPageSize, offset: offset
            )
            all.append(contentsOf: page.activities)
            if page.activities.isEmpty || all.count >= page.total { break }
            offset = all.count
        }
        return all
    }

    // MARK: - 渲染（窗口切片 → 各图表门控）

    private func render() {
        let cur = loadData?.current
        hasLoad = cur != nil
        buildMetrics()
        buildLoadStats(cur)
        buildReadiness(cur)

        // RHR：health 记录倒序取（最新在前），过滤有值后取窗口尾段。
        let healthRows = (healthData?.health ?? []).reversed().filter { $0.rhr != nil }.map { ($0.date, $0.rhr!) }
        let rhrRows = Array(healthRows.suffix(trendDays))
        rhrSeries = rhrRows.enumerated().map { i, row in
            TrendPoint(x: Double(i), y: row.1, label: formatDateShort(row.0), color: nil)
        }
        rhrBaseline = healthData?.rhrBaseline
        hasRhrChart = rhrSeries.count >= 2

        // HRV：逐日 last_night_avg。
        let hrvRows = Array((hrvData?.hrv ?? []).filter { $0.lastNightAvg != nil }.suffix(trendDays))
        hrvSeries = hrvRows.enumerated().map { i, row in
            TrendPoint(x: Double(i), y: row.lastNightAvg, label: formatDateShort(row.date), color: nil)
        }
        if let low = healthData?.hrv.hrvNormalLow, let high = healthData?.hrv.hrvNormalHigh {
            hrvBand = (low, high)
        } else {
            hrvBand = nil
        }
        hasHrvChart = hrvSeries.count >= 2

        let series = loadData?.series ?? []
        let window = Array(series.suffix(trendDays))

        // 每日剂量：coverage unknown 打洞。
        doseSeries = window.enumerated().map { i, r in
            TrendPoint(x: Double(i),
                       y: r.coverageStatus == "unknown" ? nil : r.trainingDose,
                       label: formatDateShort(r.date), color: nil)
        }
        hasDoseChart = hasLoad && doseSeries.contains { $0.y != nil }

        chronicSeries = window.enumerated().map { i, r in
            TrendPoint(x: Double(i),
                       y: r.coverageStatus == "unknown" ? nil : r.chronicLoad,
                       label: formatDateShort(r.date), color: nil)
        }
        acuteSeries = window.enumerated().map { i, r in
            TrendPoint(x: Double(i),
                       y: r.coverageStatus == "unknown" ? nil : r.acuteLoad,
                       label: formatDateShort(r.date), color: nil)
        }
        hasLoadChart = hasLoad && (chronicSeries + acuteSeries).filter { $0.y != nil }.count >= 2

        formSeries = window.enumerated().map { i, r in
            let hidden = r.coverageStatus == "unknown" || r.form == nil
            return TrendPoint(x: Double(i),
                              y: hidden ? nil : r.form,
                              label: formatDateShort(r.date),
                              color: hidden ? nil : formColor(form: r.form, chronic: r.chronicLoad))
        }
        hasFormChart = hasLoad && formSeries.contains { $0.y != nil }

        let buckets = aggregateWeeklyDose(records: series, todayYmd: todayYmd)
        weekSeries = buckets.enumerated().map { i, b in
            TrendPoint(x: Double(i),
                       y: b.totalDose.map { ($0 * 10).rounded() / 10 },
                       label: b.weekLabel, color: nil)
        }
        hasWeekChart = hasLoad && weekSeries.contains { $0.y != nil }

        heatWeeks = buildHeatWeeks(cells: buildHeatCells(series: series, weeks: Self.heatWeeks, todayYmd: todayYmd))
        heatSelected = nil

        if let ctl = cur?.chronicLoad, ctl > 0 {
            currentCtlNote = "当前 CTL ≈ \(Int(ctl.rounded())) · 对应阈值 ±\(Int((ctl * 0.1).rounded())) / ±\(Int((ctl * 0.25).rounded()))"
        } else {
            currentCtlNote = ""
        }
        calibrationLine = "Calibration: \(zonesData?.threshold?.asOfDate ?? "—") · 来源：STRIDE 自研算法"
        loadDateLine = "Training load latest: \(cur?.date ?? "—")"
    }

    /// 窗口切换重渲染（含图表重建）。
    public func selectWindow(_ days: Int) {
        guard Self.trendWindows.contains(days), days != trendDays else { return }
        trendDays = days
        render()
    }

    /// 点格展开当日详情；再点同格收起（按完整日期比较）。
    public func selectHeatCell(_ cell: HeatCell) {
        guard cell.state != .future else { return }
        if let selected = heatSelected, selected.date == cell.date {
            heatSelected = nil
            return
        }
        heatSelected = heatDetail(cell)
    }

    // MARK: - 指标卡 / 负荷格 / readiness

    private func buildMetrics() {
        let healthRows = healthData?.health ?? []
        let latestRhrRow = healthRows.first { $0.rhr != nil }
        let latestRhr = latestRhrRow?.rhr
        let latestRhrDate = latestRhrRow.map { formatDateShort(normalizeYmd($0.date)) }

        let hrvRows = (hrvData?.hrv ?? []).reversed()
        let latestHrvRow = hrvRows.first { $0.lastNightAvg != nil }
        let latestHrv = latestHrvRow?.lastNightAvg
        let latestHrvDate = latestHrvRow.map { formatDateShort($0.date) }
        var hrvBaseline = ""
        if let low = healthData?.hrv.hrvNormalLow, let high = healthData?.hrv.hrvNormalHigh {
            hrvBaseline = "正常 \(Int(low))-\(Int(high)) ms"
        }

        let threshold = zonesData?.threshold
        let paceStr: String
        if let pace = threshold?.pacePerKmSec {
            paceStr = String(format: "%d:%02d", Int(pace) / 60, Int(pace) % 60)
        } else {
            paceStr = "—"
        }
        let hrStr = threshold?.hrBpm != nil ? String(Int(threshold!.hrBpm!.rounded())) : "—"

        metrics = [
            MetricCardVM(
                label: "静息心率",
                sub: latestRhrDate.map { "\($0) · 手表读数" } ?? "手表读数",
                value: latestRhr != nil ? String(Int(latestRhr!.rounded())) : "—",
                unit: "bpm",
                baseline: healthData?.rhrBaseline != nil ? "基线 \(Int(healthData!.rhrBaseline!.rounded())) bpm" : "",
                color: 0x0097A7
            ),
            MetricCardVM(
                label: "心率变异性",
                sub: latestHrvDate.map { "\($0) · 手表读数" } ?? "手表读数",
                value: latestHrv != nil ? String(Int(latestHrv!.rounded())) : "—",
                unit: "ms",
                baseline: hrvBaseline,
                color: 0x7A4DD4
            ),
            MetricCardVM(
                label: "阈值配速",
                sub: "STRIDE Threshold Pace",
                value: paceStr,
                unit: "/km",
                baseline: threshold?.speedConfidence.map { "置信 \($0)" } ?? "",
                color: 0x00A85A
            ),
            MetricCardVM(
                label: "阈值心率",
                sub: "STRIDE Threshold HR",
                value: hrStr,
                unit: "bpm",
                baseline: threshold?.hrConfidence.map { "置信 \($0)" } ?? "",
                color: 0xD97706
            ),
        ]
    }

    private func buildLoadStats(_ cur: StrideTrainingLoadRecord?) {
        guard let cur else {
            loadStats = []
            return
        }
        loadStats = [
            LoadStatVM(label: "训练负荷", value: cur.trainingDose != nil ? String(Int(cur.trainingDose!.rounded())) : "—", color: 0xE68A00),
            LoadStatVM(label: "急性负荷", value: Fmt.decimalStr(cur.acuteLoad), color: 0xD97706),
            LoadStatVM(label: "慢性负荷", value: Fmt.decimalStr(cur.chronicLoad), color: 0x0097A7),
            LoadStatVM(
                label: "竞技状态",
                value: cur.form != nil ? "\(cur.form! > 0 ? "+" : "")\(String(format: "%.1f", cur.form!))" : "—",
                color: classifyForm(form: cur.form, chronic: cur.chronicLoad) == .overload ? 0xD32F2F : 0x00A85A
            ),
            LoadStatVM(label: "负荷比", value: cur.loadRatio != nil ? String(format: "%.2f", cur.loadRatio!) : "—", color: 0x7A4DD4),
            LoadStatVM(label: "状态", value: loadStateLabel(ratio: cur.loadRatio), color: 0x2C3340),
        ]
    }

    private func buildReadiness(_ cur: StrideTrainingLoadRecord?) {
        let gate = cur?.readinessGate
        readinessColor = Readiness.color(gate: gate)
        readinessLabel = gate != nil
            ? "\(Readiness.gateLabel(gate: gate)) · \(Readiness.label(gate: gate))"
            : "—"
        readinessReasons = (cur?.readinessReasons ?? []).joined(separator: " · ")
    }

    // MARK: - 热力图日详情

    private func heatDetail(_ cell: HeatCell) -> HeatDayDetail {
        let title = "\(formatDateShort(cell.date)) · \(Shanghai.weekdayLabel(cell.date))"
        let doseText: String
        switch cell.state {
        case .unknown: doseText = "数据未确认"
        case .absent: doseText = "历史无记录"
        default: doseText = cell.dose != nil ? "训练负荷 \(Int(cell.dose!.rounded()))" : "训练负荷 —"
        }
        var lines: [String] = []
        for a in activitiesByDate[cell.date] ?? [] {
            let sport = chineseSportName(a.sportName)
            let hr = a.avgHr != nil ? String(Int(a.avgHr!.rounded())) : "—"
            if isDistanceSport(a.sportName) {
                let pace = a.avgPaceSKm != nil ? Fmt.pace(a.avgPaceSKm).replacingOccurrences(of: "/km", with: "") : "—"
                lines.append("\(sport) \(String(format: "%.1f", a.distanceKm))km · 平均配速 \(pace) · 平均心率 \(hr)")
            } else {
                lines.append("\(sport) \(formatDurationHuman(a.durationS)) · 平均心率 \(hr)")
            }
        }
        if lines.isEmpty && cell.state == .rest { lines.append("休息日") }
        return HeatDayDetail(date: cell.date, title: title, dose: doseText, lines: lines)
    }
}
