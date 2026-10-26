import Foundation
import Observation
import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

// 自定义比赛全屏表单（devops#769，baseline §5.5 直译）：必填 名称/日期；
// 类型七值 chips 默认越野跑（越野/超长越野高亮建议填爬升）；距离 ≤99999.9、
// 爬升非负整数校验；PUT 全量更新显式 null/空串；编辑回显走 AppModel 交接
// （小程序 eventChannel 回显延迟坑在 iOS 自然消失）。保存成功返回列表页。

@MainActor
@Observable
public final class CustomRaceFormModel {

    public var saving = false
    /// nil = 新建；非 nil = 编辑该 id。
    public private(set) var editingId: Int?
    public var name = ""
    /// 上海 YYYY-MM-DD。
    public var date = ""
    public var typeToken = "Trail"
    public var dist = ""
    public var ascent = ""
    public var city = ""
    public var website = ""
    public var note = ""
    public var state: CustomRaceState = .want
    public var toast: String?

    private var repo: RaceRepository?
    private var router: AppRouter?

    public init() {}

    /// 首次可见：消费列表页交接的编辑行（一次性）。
    public func activate(app: AppModel) {
        guard repo == nil else { return }
        repo = RaceRepository(api: app.api)
        router = app.router
        if let race = app.takePendingCustomRaceEdit() {
            editingId = race.id
            name = race.name
            date = race.raceDate
            typeToken = race.itemType
            dist = race.distanceKm.map { Fmt.autoStr($0) } ?? ""
            ascent = race.ascentM.map(String.init) ?? ""
            city = race.city
            website = race.website
            note = race.note
            state = race.state
        }
    }

    public var isEditing: Bool { editingId != nil }
    public var navTitle: String { isEditing ? "编辑自定义比赛" : "添加自定义比赛" }

    /// 越野/超长越野高亮建议填爬升。
    public var suggestAscent: Bool { typeToken == "Trail" || typeToken == "Ultra" }

    public func selectType(_ token: String) {
        guard !token.isEmpty, token != typeToken else { return }
        typeToken = token
    }

    public func selectState(_ value: CustomRaceState) {
        state = value
    }

    // MARK: - 保存

    public func save() async {
        guard let repo, !saving else { return }
        switch validateCustomRaceForm(
            name: name, raceDate: date, itemType: typeToken,
            distanceKm: dist, ascentM: ascent,
            city: city, website: website, note: note, state: state
        ) {
        case .failed(let message):
            toast = message
        case .ok(let body):
            saving = true
            defer { saving = false }
            do {
                if let id = editingId {
                    try await repo.updateCustomRace(id: id, body)
                } else {
                    try await repo.createCustomRace(body)
                }
                // 成功返回列表页（列表 onShow 聚合刷新）。
                router?.pop()
            } catch let e as ApiError {
                // 服务端 detail 透传。
                toast = e.detail.isEmpty ? "保存失败，请稍后重试" : e.detail
            } catch {
                toast = "保存失败，请稍后重试"
            }
        }
    }

    public func clearToast() { toast = nil }
}

/// 表单页（名称/日期/类型 chips/距离/爬升/城市/官网/备注/状态 chips/保存）。
public struct CustomRaceFormView: View {

    @Environment(AppModel.self) private var app
    @State private var model = CustomRaceFormModel()
    @State private var pickingDate = false

    public init() {}

    public var body: some View {
        let t = app.theme.current
        ScrollView {
            VStack(alignment: .leading, spacing: t.space(.lg)) {
                fieldLabel("比赛名称 *")
                TextField("如「2026 大理越野赛」", text: $model.name)
                    .fieldStyle()

                fieldLabel("比赛日期 *")
                Button {
                    pickingDate = true
                } label: {
                    HStack {
                        Text(model.date.isEmpty ? "选择日期" : model.date)
                            .font(t.font(.fs14, weight: model.date.isEmpty ? .regular : .medium, mono: true))
                            .foregroundStyle(model.date.isEmpty ? t.mutedTwo : t.foreground)
                        Spacer()
                        Image(systemName: "calendar")
                            .font(.system(size: 14))
                            .foregroundStyle(t.mutedTwo)
                    }
                    .fieldStyle()
                }
                .buttonStyle(.plain)

                fieldLabel("类型")
                flexChips(customTypeChips.map { ($0.token, $0.label) }, selected: model.typeToken) {
                    model.selectType($0)
                }
                if model.suggestAscent {
                    Text("越野比赛建议填写累计爬升，方便教练评估强度")
                        .font(t.font(.fs11))
                        .foregroundStyle(t.warning)
                }

                fieldLabel("距离 (km)")
                TextField("如 42.2", text: $model.dist)
                    .fieldStyle()
                    .raceKeyboard(.decimalPad)

                fieldLabel("累计爬升 (m)")
                TextField("如 1200", text: $model.ascent)
                    .fieldStyle()
                    .raceKeyboard(.numberPad)

                fieldLabel("城市")
                TextField("如 云南省大理白族自治州", text: $model.city)
                    .fieldStyle()

                fieldLabel("官网")
                TextField("https://…", text: $model.website)
                    .fieldStyle()
                    .raceKeyboard(.url)
                    .noAutocapitalization()
                    .autocorrectionDisabled()

                fieldLabel("备注")
                TextField("住宿/交通/目标…", text: $model.note, axis: .vertical)
                    .lineLimit(1...3)
                    .fieldStyle()

                fieldLabel("状态")
                flexChips([
                    (CustomRaceState.want.rawValue, "想跑"),
                    (CustomRaceState.registered.rawValue, "已报名"),
                ], selected: model.state.rawValue) { raw in
                    if let s = CustomRaceState(rawValue: raw) {
                        model.selectState(s)
                    }
                }

                Button {
                    Task { await model.save() }
                } label: {
                    HStack(spacing: 6) {
                        if model.saving { ProgressView().controlSize(.small).tint(t.onAccent) }
                        Text("保存")
                    }
                    .font(t.font(.fs15, weight: .bold))
                    .foregroundStyle(t.onAccent)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, t.space(.sm))
                    .background(Capsule().fill(t.accent))
                }
                .buttonStyle(.plain)
                .disabled(model.saving)
                .padding(.top, t.space(.md))
            }
            .padding(.horizontal, t.space(.md))
            .padding(.vertical, t.space(.lg))
        }
        .background(t.background)
        .navigationTitle(model.navTitle)
        .inlineNavigationTitle()
        .scrollDismissesKeyboard(.interactively)
        .task { model.activate(app: app) }
        .sheet(isPresented: $pickingDate) {
            // 日期无上下限：过去=补录、远未来允许（#457 修正决议）。
            DatePicker(
                "比赛日期",
                selection: Binding(
                    get: { Shanghai.ymdPickerDate(model.date) },
                    set: { model.date = Shanghai.pickerYMD($0) }
                ),
                displayedComponents: .date
            )
            .datePickerStyle(.graphical)
            .presentationDetents([.medium, .large])
        }
        .raceToast(model.toast) { model.clearToast() }
    }

    // MARK: - 组件

    private func fieldLabel(_ text: String) -> some View {
        let t = app.theme.current
        return Text(text)
            .font(t.font(.fs13, weight: .bold))
            .foregroundStyle(t.foreground)
    }

    private func flexChips(_ chips: [(token: String, label: String)], selected: String, select: @escaping (String) -> Void) -> some View {
        let t = app.theme.current
        return FlowChips(chips: chips.map { chip in
            ChipItem(id: chip.token, label: chip.label, on: chip.token == selected)
        }) { select($0) }
        .environment(app)
    }
}

/// chips 项（表单类型/状态共用）。
struct ChipItem: Identifiable {
    let id: String
    let label: String
    let on: Bool
}

/// 自动换行的 chips 容器（Grid 自适应列）。
struct FlowChips: View {

    @Environment(AppModel.self) private var app
    let chips: [ChipItem]
    let select: (String) -> Void

    private let columns = [GridItem(.adaptive(minimum: 74), spacing: 8)]

    var body: some View {
        let t = app.theme.current
        LazyVGrid(columns: columns, alignment: .leading, spacing: t.space(.sm)) {
            ForEach(chips) { chip in
                Button {
                    select(chip.id)
                } label: {
                    Text(chip.label)
                        .font(t.font(.fs13, weight: chip.on ? .bold : .medium))
                        .foregroundStyle(chip.on ? t.onAccent : t.foregroundSoft)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, t.space(.xs))
                        .background(Capsule().fill(chip.on ? t.accent : t.surface))
                        .overlay(Capsule().stroke(chip.on ? Color.clear : t.borderSoft, lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
        }
    }
}

// MARK: - 私有修饰符与日期桥

private extension View {
    func fieldStyle() -> some View {
        modifier(FieldStyle())
    }
}

struct FieldStyle: ViewModifier {
    @Environment(AppModel.self) private var app

    func body(content: Content) -> some View {
        let t = app.theme.current
        return content
            .font(t.font(.fs14))
            .foregroundStyle(t.foreground)
            .padding(.horizontal, t.space(.md))
            .padding(.vertical, t.space(.sm))
            .background(RoundedRectangle(cornerRadius: t.radius(.sm)).fill(t.surface))
            .overlay(RoundedRectangle(cornerRadius: t.radius(.sm)).stroke(t.borderSoft, lineWidth: 1))
            .autocorrectionDisabled()
    }
}

/// iOS 键盘类型（macOS 宿主编译兜底为无操作，同 PlatformModifiers 模式）。
enum RaceKeyboardKind { case decimalPad, numberPad, url }

struct RaceKeyboardModifier: ViewModifier {
    let kind: RaceKeyboardKind

    func body(content: Content) -> some View {
        #if canImport(UIKit)
        switch kind {
        case .decimalPad: content.keyboardType(.decimalPad)
        case .numberPad: content.keyboardType(.numberPad)
        case .url: content.keyboardType(.URL)
        }
        #else
        content
        #endif
    }
}

extension View {
    func raceKeyboard(_ kind: RaceKeyboardKind) -> some View {
        modifier(RaceKeyboardModifier(kind: kind))
    }
}

extension Shanghai {
    /// YYYY-MM-DD → DatePicker Date（上海 00:00 口径）；空/非法 → 今天。
    static func ymdPickerDate(_ ymd: String, now: Date = Date()) -> Date {
        guard ymd.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else { return now }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = Shanghai.timeZone
        return cal.date(from: DateComponents(year: Int(ymd.prefix(4)), month: Int(ymd.dropFirst(5).prefix(2)), day: Int(ymd.suffix(2)))) ?? now
    }

    /// DatePicker Date → 上海 YYYY-MM-DD。
    static func pickerYMD(_ date: Date) -> String {
        let fmt = DateFormatter()
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.timeZone = Shanghai.timeZone
        fmt.dateFormat = "yyyy-MM-dd"
        return fmt.string(from: date)
    }
}
