import SwiftUI

/// 比赛策略报告页（devops#769，baseline §5.3 直译）：hero（赛名/比赛日/目标
/// + 和教练调整/分享/配速卡）→ 版本 pills → 策略摘要 → 五列配速表（配速/说明
/// 可编辑，用时自动重算）→ 补给计划（增删改）→ 打包清单 → 赛道/天气提示 →
/// 底部动作（保存[dirty]/删除 或 草稿[应用并保存]）。
public struct RaceStrategyView: View {

    @Environment(AppModel.self) private var app
    @State private var model: RaceStrategyModel
    @State private var posterOpen = false

    public init(raceId: Int, target: String?) {
        _model = State(initialValue: RaceStrategyModel(raceId: raceId, target: target))
    }

    public var body: some View {
        let t = app.theme.current
        Group {
            if model.loading {
                ProgressView().tint(t.mutedTwo).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if !model.error.isEmpty {
                errorCard
            } else if let view = model.view {
                ScrollView {
                    VStack(alignment: .leading, spacing: t.space(.lg)) {
                        hero(view)
                        if !model.draft && !model.versions.isEmpty { versionPills }
                        summaryBlock(view)
                        paceTable(view)
                        fuelingBlock(view)
                        if !view.checklistRows.isEmpty { checklistBlock(view) }
                        if !view.courseTips.isEmpty { tipsBlock(title: "赛道提示", lines: view.courseTips) }
                        if !view.weatherTips.isEmpty {
                            tipsBlock(title: "天气提示", lines: view.weatherTips.components(separatedBy: "\n"))
                        }
                        if !view.basisNote.isEmpty { basisBlock(view) }
                    }
                    .padding(.horizontal, t.space(.md))
                    .padding(.vertical, t.space(.sm))
                    .safeAreaInset(edge: .bottom) { bottomBar }
                }
            }
        }
        .background(t.background)
        .navigationTitle("比赛策略报告")
        .inlineNavigationTitle()
        .task { await model.activate(app: app) }
        .raceToast(model.toast) { model.clearToast() }
        .confirmationDialog(
            "切换目标版本",
            isPresented: Binding(get: { model.pendingSwitchTarget != nil }, set: { if !$0 { model.pendingSwitchTarget = nil } }),
            titleVisibility: .visible
        ) {
            Button("丢弃并切换", role: .destructive) { model.confirmSwitchDiscard() }
            Button("继续编辑", role: .cancel) { model.pendingSwitchTarget = nil }
        } message: {
            Text("当前版本有未保存的修改，切换后将丢弃。")
        }
        .alert("删除目标版本", isPresented: $model.confirmDelete) {
            Button("删除", role: .destructive) { Task { await model.deleteActiveVersion() } }
            Button("取消", role: .cancel) {}
        } message: {
            Text(model.versions.first(where: \.active).map { "删除 \($0.target) 这一版策略？其它目标版本不受影响。" } ?? "删除这一版策略？其它目标版本不受影响。")
        }
        .sheet(isPresented: $posterOpen) {
            if let view = model.view {
                PacePosterSheet(data: view, raceDayText: model.raceDayText)
            }
        }
    }

    // MARK: - 区块

    private var errorCard: some View {
        let t = app.theme.current
        return VStack(spacing: t.space(.sm)) {
            Image(systemName: "doc.text.magnifyingglass")
                .font(.system(size: 28, weight: .medium))
                .foregroundStyle(t.mutedTwo)
            Text(model.error)
                .font(t.font(.fs14, weight: .medium))
                .foregroundStyle(t.muted)
                .multilineTextAlignment(.center)
                .padding(.horizontal, t.space(.xl))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func hero(_ view: StrategyViewData) -> some View {
        let t = app.theme.current
        return VStack(alignment: .leading, spacing: t.space(.sm)) {
            Text("\(model.raceDayText) · \(view.itemTypeLabel)")
                .font(t.font(.fs13))
                .foregroundStyle(t.muted)
            Text(view.raceName)
                .font(t.font(.fs20, weight: .bold))
                .foregroundStyle(t.foreground)
            HStack(alignment: .firstTextBaseline, spacing: t.space(.sm)) {
                Text(view.targetTime)
                    .font(t.font(.fsDisplay40, weight: .bold, mono: true))
                    .foregroundStyle(t.accentDeep)
                if !view.targetPace.isEmpty {
                    Text("配速 \(view.targetPace)")
                        .font(t.font(.fs13, weight: .medium, mono: true))
                        .foregroundStyle(t.muted)
                }
                if model.dirty {
                    Text("未保存")
                        .font(t.font(.fs10, weight: .medium))
                        .foregroundStyle(t.warning)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(t.warning.opacity(0.12)))
                }
            }
            HStack(spacing: t.space(.sm)) {
                Button {
                    model.coachTap(app: app)
                } label: {
                    Label("和教练调整", systemImage: "bubble.left.and.text.bubble.right")
                        .font(t.font(.fs13, weight: .bold))
                        .foregroundStyle(t.onAccent)
                        .padding(.horizontal, t.space(.md))
                        .padding(.vertical, t.space(.xs))
                        .background(Capsule().fill(t.accent))
                }
                .buttonStyle(.plain)
                shareLink(view)
                Button {
                    posterOpen = true
                } label: {
                    Label("配速卡", systemImage: "photo")
                        .font(t.font(.fs13, weight: .medium))
                        .foregroundStyle(t.accentDeep)
                        .padding(.horizontal, t.space(.md))
                        .padding(.vertical, t.space(.xs))
                        .background(Capsule().fill(t.accentTint))
                }
                .buttonStyle(.plain)
            }
        }
    }

    /// 分享：已落库版本带 owner+race+version 落只读页（#506 三元组）；
    /// 草稿/无版本行 id 分享落赛事详情。
    @ViewBuilder
    private func shareLink(_ view: StrategyViewData) -> some View {
        let t = app.theme.current
        if let url = model.shareTarget(app: app) {
            ShareLink(item: url, preview: SharePreview(strategyShareTitle(view))) {
                Label("分享", systemImage: "square.and.arrow.up")
                    .font(t.font(.fs13, weight: .medium))
                    .foregroundStyle(t.accentDeep)
                    .padding(.horizontal, t.space(.md))
                    .padding(.vertical, t.space(.xs))
                    .background(Capsule().fill(t.accentTint))
            }
        }
    }

    private var versionPills: some View {
        let t = app.theme.current
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: t.space(.sm)) {
                ForEach(model.versions, id: \.target) { pill in
                    Button {
                        model.requestVersionSwitch(pill.target)
                    } label: {
                        Text(pill.target)
                            .font(t.font(.fs13, weight: pill.active ? .bold : .medium, mono: true))
                            .foregroundStyle(pill.active ? t.onAccent : t.foregroundSoft)
                            .padding(.horizontal, t.space(.md))
                            .padding(.vertical, t.space(.xs))
                            .background(Capsule().fill(pill.active ? t.accent : t.surface))
                            .overlay(Capsule().stroke(pill.active ? Color.clear : t.borderSoft, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func summaryBlock(_ view: StrategyViewData) -> some View {
        let t = app.theme.current
        return card {
            Text(view.summary)
                .font(t.font(.fs13))
                .foregroundStyle(t.foregroundSoft)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - 配速表（五列）

    private func paceTable(_ view: StrategyViewData) -> some View {
        let t = app.theme.current
        return card {
            VStack(spacing: 0) {
                HStack(spacing: t.space(.xs)) {
                    tableHeader("分段")
                    tableHeader("配速", width: 64)
                    tableHeader("本段用时", width: 56)
                    tableHeader("累计", width: 56)
                    tableHeader("说明")
                }
                ForEach(view.paceRows) { row in
                    paceRow(row)
                }
            }
        }
    }

    private func tableHeader(_ text: String, width: CGFloat? = nil) -> some View {
        let t = app.theme.current
        return Text(text)
            .font(t.font(.fs11))
            .foregroundStyle(t.mutedTwo)
            .frame(width: width, alignment: .leading)
            .frame(maxWidth: width == nil ? .infinity : nil, alignment: .leading)
    }

    private func paceRow(_ row: PaceRowView) -> some View {
        let t = app.theme.current
        return VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: t.space(.xs)) {
                // 分段（距离短标签 + 描述小字）
                VStack(alignment: .leading, spacing: 1) {
                    Text(row.distance)
                        .font(t.font(.fs13, weight: .medium, mono: true))
                        .foregroundStyle(t.foreground)
                        .lineLimit(1)
                    if !row.desc.isEmpty {
                        Text(row.desc)
                            .font(t.font(.fs10))
                            .foregroundStyle(t.mutedTwo)
                            .lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                // 配速（可编辑）
                TextField("", text: paceBinding(row))
                    .font(t.font(.fs13, weight: .medium, mono: true))
                    .foregroundStyle(t.accentDeep)
                    .multilineTextAlignment(.center)
                    .frame(width: 64)
                    .autocorrectionDisabled()
                    .noAutocapitalization()
                Text(row.segmentTime)
                    .font(t.font(.fs13, mono: true))
                    .foregroundStyle(t.foregroundSoft)
                    .frame(width: 56, alignment: .leading)
                Text(row.cumulativeTime)
                    .font(t.font(.fs13, mono: true))
                    .foregroundStyle(t.foregroundSoft)
                    .frame(width: 56, alignment: .leading)
                // 说明（可编辑）
                TextField("", text: noteBinding(row), axis: .vertical)
                    .font(t.font(.fs12))
                    .foregroundStyle(t.foregroundSoft)
                    .lineLimit(1...2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .autocorrectionDisabled()
            }
            .padding(.vertical, t.space(.sm))
            Rectangle().fill(t.borderSoft).frame(height: 0.5)
        }
    }

    private func paceBinding(_ row: PaceRowView) -> Binding<String> {
        Binding(
            get: { model.view?.paceRows.first(where: { $0.id == row.id })?.pace ?? row.pace },
            set: { model.patchPaceRow(row.index, pace: $0) }
        )
    }

    private func noteBinding(_ row: PaceRowView) -> Binding<String> {
        Binding(
            get: { model.view?.paceRows.first(where: { $0.id == row.id })?.note ?? row.note },
            set: { model.patchPaceRow(row.index, note: $0) }
        )
    }

    // MARK: - 补给

    private func fuelingBlock(_ view: StrategyViewData) -> some View {
        let t = app.theme.current
        return card {
            VStack(alignment: .leading, spacing: t.space(.sm)) {
                HStack {
                    Text("补给计划").font(t.font(.fs13, weight: .bold)).foregroundStyle(t.foreground)
                    Spacer()
                    Button {
                        model.addFuelingRow()
                    } label: {
                        Label("添加", systemImage: "plus")
                            .font(t.font(.fs12, weight: .medium))
                            .foregroundStyle(t.accentDeep)
                    }
                    .buttonStyle(.plain)
                }
                ForEach(view.fuelingRows) { row in
                    HStack(spacing: t.space(.sm)) {
                        TextField("时间点", text: fuelingBinding(row, \.timePoint))
                            .font(t.font(.fs13, mono: true))
                            .foregroundStyle(t.foreground)
                            .frame(width: 76, alignment: .leading)
                            .autocorrectionDisabled()
                        TextField("内容", text: fuelingBinding(row, \.content))
                            .font(t.font(.fs13))
                            .foregroundStyle(t.foregroundSoft)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .autocorrectionDisabled()
                        Button {
                            model.removeFuelingRow(row.index)
                        } label: {
                            Image(systemName: "minus.circle")
                                .font(.system(size: 14, weight: .medium))
                                .foregroundStyle(t.mutedTwo)
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.vertical, 2)
                }
            }
        }
    }

    private func fuelingBinding(_ row: FuelingRowView, _ keyPath: WritableKeyPath<FuelingRowView, String>) -> Binding<String> {
        Binding(
            get: {
                model.view?.fuelingRows.first(where: { $0.id == row.id })?[keyPath: keyPath]
                    ?? row[keyPath: keyPath]
            },
            set: { newValue in
                if keyPath == \.timePoint {
                    model.patchFuelingRow(row.index, timePoint: newValue)
                } else {
                    model.patchFuelingRow(row.index, content: newValue)
                }
            }
        )
    }

    // MARK: - 只读块

    private func checklistBlock(_ view: StrategyViewData) -> some View {
        let t = app.theme.current
        return card {
            VStack(alignment: .leading, spacing: t.space(.sm)) {
                Text("补给打包清单").font(t.font(.fs13, weight: .bold)).foregroundStyle(t.foreground)
                ForEach(view.checklistRows) { row in
                    HStack(alignment: .top, spacing: t.space(.sm)) {
                        Text(row.item)
                            .font(t.font(.fs13, weight: .medium))
                            .foregroundStyle(t.foreground)
                        Text("×\(row.count)")
                            .font(t.font(.fs13, mono: true))
                            .foregroundStyle(t.accentDeep)
                        Spacer()
                        Text(row.note)
                            .font(t.font(.fs12))
                            .foregroundStyle(t.muted)
                            .multilineTextAlignment(.trailing)
                            .frame(maxWidth: 180, alignment: .trailing)
                    }
                    .padding(.vertical, 2)
                }
            }
        }
    }

    private func tipsBlock(title: String, lines: [String]) -> some View {
        card {
            VStack(alignment: .leading, spacing: t_spaceSm) {
                Text(title).font(app.theme.current.font(.fs13, weight: .bold)).foregroundStyle(app.theme.current.foreground)
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                    HStack(alignment: .top, spacing: app.theme.current.space(.sm)) {
                        Text("·").foregroundStyle(app.theme.current.accent)
                        Text(line)
                            .font(app.theme.current.font(.fs13))
                            .foregroundStyle(app.theme.current.foregroundSoft)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
    }

    private var t_spaceSm: CGFloat { app.theme.current.space(.sm) }

    private func basisBlock(_ view: StrategyViewData) -> some View {
        card {
            VStack(alignment: .leading, spacing: t_spaceSm) {
                Text("制定依据").font(app.theme.current.font(.fs13, weight: .bold)).foregroundStyle(app.theme.current.foreground)
                Text(view.basisNote)
                    .font(app.theme.current.font(.fs13))
                    .foregroundStyle(app.theme.current.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func card<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        let t = app.theme.current
        return content()
            .padding(t.space(.md))
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: t.radius(.md)).fill(t.surface))
            .overlay(RoundedRectangle(cornerRadius: t.radius(.md)).stroke(t.borderSoft, lineWidth: 1))
    }

    // MARK: - 底部动作

    private var bottomBar: some View {
        let t = app.theme.current
        return HStack(spacing: t.space(.md)) {
            if model.draft {
                Button {
                    Task { await model.applyDraft() }
                } label: {
                    HStack(spacing: 6) {
                        if model.applying { ProgressView().controlSize(.small).tint(t.onAccent) }
                        Text("应用并保存")
                    }
                    .font(t.font(.fs15, weight: .bold))
                    .foregroundStyle(t.onAccent)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, t.space(.sm))
                    .background(Capsule().fill(t.accent))
                }
                .buttonStyle(.plain)
                .disabled(model.applying)
            } else {
                Button {
                    Task { await model.save() }
                } label: {
                    HStack(spacing: 6) {
                        if model.saving { ProgressView().controlSize(.small).tint(t.onAccent) }
                        Text("保存")
                    }
                    .font(t.font(.fs15, weight: .bold))
                    .foregroundStyle(model.dirty ? t.onAccent : t.mutedTwo)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, t.space(.sm))
                    .background(Capsule().fill(model.dirty ? t.accent : t.grid))
                }
                .buttonStyle(.plain)
                .disabled(!model.dirty || model.saving)

                Button {
                    model.confirmDelete = true
                } label: {
                    HStack(spacing: 6) {
                        if model.deleting { ProgressView().controlSize(.small) }
                        Text("删除")
                    }
                    .font(t.font(.fs15, weight: .bold))
                    .foregroundStyle(t.danger)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, t.space(.sm))
                    .background(Capsule().fill(t.danger.opacity(0.1)))
                }
                .buttonStyle(.plain)
                .disabled(model.deleting)
            }
        }
        .padding(.horizontal, t.space(.md))
        .padding(.vertical, t.space(.sm))
        .background(t.background.opacity(0.96))
        .overlay(alignment: .top) { Rectangle().fill(t.borderSoft).frame(height: 0.5) }
    }
}
