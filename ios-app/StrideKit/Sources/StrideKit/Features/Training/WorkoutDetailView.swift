import SwiftUI

/// 课表详情页（devops#768 PR-5，baseline §4.1 直译 + 10-21 样式定稿）：
/// 类型 chip hero → 指标行 → 跑课分段组（骑线 ×N + 休息独立行 + 心率帽）/
/// 力量动作行 → 课表备注 → 教练备注 → 自建课分享 pill；四态 loadState。
public struct WorkoutDetailView: View {

    @Environment(AppModel.self) private var app
    @State private var model: WorkoutDetailModel
    @State private var shareOpen = false

    public init(date: String, workoutId: String, title: String?) {
        _model = State(initialValue: WorkoutDetailModel(date: date, workoutId: workoutId, title: title))
    }

    public var body: some View {
        ScrollView {
            switch model.loadState {
            case .loading:
                ProgressView()
                    .tint(app.theme.current.mutedTwo)
                    .padding(.top, app.theme.current.space(.xxxl))
            case .notfound:
                stateCard(title: "未找到课表", subtitle: "课表可能已删除或已过期")
            case .error:
                stateCard(title: "加载失败", subtitle: "请稍后重试", retry: true)
            case .ready:
                readyContent
            }
        }
        .background(app.theme.current.background)
        .navigationTitle(model.header.name.isEmpty ? "课表详情" : model.header.name)
        .inlineNavigationTitle()
        .task { await model.activate(app: app) }
        .sheet(isPresented: $shareOpen) { shareSheet }
    }

    @ViewBuilder
    private var readyContent: some View {
        LazyVStack(alignment: .leading, spacing: app.theme.current.space(.md)) {
            hero
            if !model.stats.isEmpty {
                statCard(model.stats)
            }
            ForEach(model.runGroups) { group in
                segmentGroupCard(group)
            }
            if !model.exercises.isEmpty {
                exercisesCard
            }
            if !model.specNote.isEmpty {
                noteCard(title: "课表备注", text: model.specNote)
            }
            if !model.coachNote.isEmpty {
                noteCard(title: "教练备注", text: model.coachNote)
            }
            if model.canShare, let url = model.shareURL {
                sharePill(url: url)
            }
        }
        .padding(.horizontal, app.theme.current.space(.md))
        .padding(.top, app.theme.current.space(.xs))
        .padding(.bottom, app.theme.current.space(.xxl))
    }

    // MARK: - Hero

    private var hero: some View {
        VStack(alignment: .leading, spacing: app.theme.current.space(.sm)) {
            HStack(spacing: app.theme.current.space(.xs)) {
                if !model.header.typeChip.isEmpty {
                    Text(model.header.typeChip)
                        .font(app.theme.current.font(.fs11, weight: .medium))
                        .foregroundStyle(app.theme.current.onAccent)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Capsule().fill(app.theme.current.accent))
                }
                if !model.header.sourceLabel.isEmpty {
                    Text(model.header.sourceLabel)
                        .font(app.theme.current.font(.fs11))
                        .foregroundStyle(app.theme.current.muted)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Capsule().strokeBorder(app.theme.current.border, lineWidth: 0.5))
                }
                Spacer()
            }
            HStack(spacing: app.theme.current.space(.xs)) {
                Image(systemName: model.header.systemImage)
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(app.theme.current.accent)
                Text(model.header.name)
                    .font(app.theme.current.font(.fs20, weight: .bold))
                    .foregroundStyle(app.theme.current.foreground)
            }
            if !model.header.dateLabel.isEmpty {
                Text(model.header.dateLabel)
                    .font(app.theme.current.font(.fs12))
                    .foregroundStyle(app.theme.current.muted)
            }
            if !model.header.summary.isEmpty {
                Text(model.header.summary)
                    .font(app.theme.current.font(.fs13))
                    .foregroundStyle(app.theme.current.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - 指标行

    private func statCard(_ stats: [StatItem]) -> some View {
        HStack(spacing: 0) {
            ForEach(Array(stats.enumerated()), id: \.offset) { _, stat in
                VStack(spacing: 2) {
                    Text(stat.value)
                        .font(app.theme.current.font(.fs15, weight: .bold, mono: true))
                        .foregroundStyle(app.theme.current.foreground)
                    Text(stat.label)
                        .font(app.theme.current.font(.fs11))
                        .foregroundStyle(app.theme.current.mutedTwo)
                }
                .frame(maxWidth: .infinity)
            }
        }
        .padding(app.theme.current.space(.md))
        .background(app.theme.current.surface)
        .clipShape(RoundedRectangle(cornerRadius: app.theme.current.radius(.md)))
    }

    // MARK: - 跑课分段组（blocks → steps 缩进；repeat>1 骑线 ×N）

    private func segmentGroupCard(_ group: SegmentGroup) -> some View {
        VStack(alignment: .leading, spacing: app.theme.current.space(.sm)) {
            if group.repeatCount > 1 {
                HStack(spacing: app.theme.current.space(.xs)) {
                    Rectangle()
                        .fill(app.theme.current.accent)
                        .frame(width: 2, height: 12)
                    Text("×\(group.repeatCount)")
                        .font(app.theme.current.font(.fs12, weight: .medium, mono: true))
                        .foregroundStyle(app.theme.current.accentDeep)
                    Text("整组重复")
                        .font(app.theme.current.font(.fs11))
                        .foregroundStyle(app.theme.current.mutedTwo)
                }
            }
            VStack(spacing: 0) {
                ForEach(group.rows) { row in
                    segmentRow(row)
                }
            }
        }
        .padding(app.theme.current.space(.md))
        .background(app.theme.current.surface)
        .clipShape(RoundedRectangle(cornerRadius: app.theme.current.radius(.md)))
    }

    private func segmentRow(_ row: SegmentRow) -> some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: app.theme.current.space(.sm)) {
                Text(row.kindLabel)
                    .font(app.theme.current.font(.fs10, weight: .medium))
                    .foregroundStyle(row.quiet ? app.theme.current.mutedTwo : Tokens.color(row.color))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background {
                        if row.quiet {
                            Capsule().strokeBorder(app.theme.current.border, lineWidth: 0.5)
                        } else {
                            Capsule().fill(Tokens.color(row.color).opacity(0.14))
                        }
                    }
                Text(row.main)
                    .font(app.theme.current.font(.fs13, weight: .medium, mono: true))
                    .foregroundStyle(row.quiet ? app.theme.current.muted : app.theme.current.foreground)
                if !row.hrCapText.isEmpty {
                    Text(row.hrCapText)
                        .font(app.theme.current.font(.fs11))
                        .foregroundStyle(app.theme.current.mutedTwo)
                }
                Spacer()
            }
            .padding(.vertical, app.theme.current.space(.sm))
            if !row.note.isEmpty {
                Text(row.note)
                    .font(app.theme.current.font(.fs12))
                    .foregroundStyle(app.theme.current.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, app.theme.current.space(.xl))
                    .padding(.bottom, app.theme.current.space(.sm))
            }
            Divider().overlay(app.theme.current.borderSoft)
        }
    }

    // MARK: - 力量动作行（图占位：10-21 样式定稿，品牌资产后补）

    private var exercisesCard: some View {
        VStack(spacing: 0) {
            ForEach(model.exercises) { ex in
                HStack(spacing: app.theme.current.space(.md)) {
                    // 力量动作图占位（strength_illustrations 品牌资产落地前）。
                    RoundedRectangle(cornerRadius: app.theme.current.radius(.sm))
                        .fill(app.theme.current.accentTint)
                        .frame(width: 40, height: 40)
                        .overlay {
                            Image(systemName: "dumbbell")
                                .font(.system(size: 15, weight: .medium))
                                .foregroundStyle(app.theme.current.accent)
                        }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(ex.name)
                            .font(app.theme.current.font(.fs14, weight: .medium))
                            .foregroundStyle(app.theme.current.foreground)
                        HStack(spacing: app.theme.current.space(.sm)) {
                            Text(ex.target)
                                .font(app.theme.current.font(.fs12, mono: true))
                                .foregroundStyle(app.theme.current.muted)
                            if !ex.rest.isEmpty {
                                Text(ex.rest)
                                    .font(app.theme.current.font(.fs11))
                                    .foregroundStyle(app.theme.current.mutedTwo)
                            }
                        }
                        if !ex.note.isEmpty {
                            Text(ex.note)
                                .font(app.theme.current.font(.fs12))
                                .foregroundStyle(app.theme.current.mutedTwo)
                        }
                    }
                    Spacer()
                }
                .padding(.vertical, app.theme.current.space(.sm))
                Divider().overlay(app.theme.current.borderSoft)
            }
        }
        .padding(.horizontal, app.theme.current.space(.md))
        .padding(.vertical, app.theme.current.space(.xs))
        .background(app.theme.current.surface)
        .clipShape(RoundedRectangle(cornerRadius: app.theme.current.radius(.md)))
    }

    // MARK: - 备注 / 分享

    private func noteCard(title: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(app.theme.current.font(.fs11)).foregroundStyle(app.theme.current.mutedTwo)
            Text(text).font(app.theme.current.font(.fs12)).foregroundStyle(app.theme.current.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(app.theme.current.space(.md))
        .background(app.theme.current.surface)
        .clipShape(RoundedRectangle(cornerRadius: app.theme.current.radius(.md)))
    }

    /// 自建课分享 pill（#704 仅 custom 源；PR-8 出向矩阵：自建课封面=
    /// 图+文案+链接——5:4 深色封面 + 课名 + workout-share `/s/` 链接整组）。
    private func sharePill(url: URL) -> some View {
        Button {
            shareOpen = true
        } label: {
            HStack(spacing: app.theme.current.space(.xs)) {
                Image(systemName: "square.and.arrow.up")
                    .font(.system(size: 13, weight: .medium))
                Text("分享课表")
            }
            .font(app.theme.current.font(.fs13, weight: .medium))
            .foregroundStyle(app.theme.current.accentDeep)
            .frame(maxWidth: .infinity)
            .padding(.vertical, app.theme.current.space(.sm))
            .background(Capsule().fill(app.theme.current.accentTint))
        }
        .buttonStyle(.plain)
    }

    /// 图+文案+链接整组（封面渲染失败自动少一项，fail-soft）。
    @ViewBuilder
    private var shareSheet: some View {
        #if canImport(UIKit)
        if let url = model.shareURL {
            ActivityShareSheet(items: shareItems(url))
        }
        #else
        // macOS 仅测试编译面
        Text(ShareCopy.workout(name: model.header.name))
        #endif
    }

    #if canImport(UIKit)
    private func shareItems(_ url: URL) -> [Any] {
        let metrics = model.stats.prefix(2).map {
            WorkoutDarkCoverView.Metric(value: $0.value, label: $0.label)
        }
        return ShareItemsBuilder.items(
            cover: ShareCoverRenderer.render(
                WorkoutDarkCoverView(name: model.header.name, metrics: metrics)
            ),
            title: ShareCopy.workout(name: model.header.name),
            url: url
        )
    }
    #endif

    // MARK: - 状态卡

    private func stateCard(title: String, subtitle: String, retry: Bool = false) -> some View {
        VStack(spacing: app.theme.current.space(.xs)) {
            Image(systemName: "calendar")
                .font(.system(size: 28, weight: .medium))
                .foregroundStyle(app.theme.current.mutedTwo)
            Text(title)
                .font(app.theme.current.font(.fs15, weight: .medium))
                .foregroundStyle(app.theme.current.muted)
            Text(subtitle)
                .font(app.theme.current.font(.fs12))
                .foregroundStyle(app.theme.current.mutedTwo)
            if retry {
                Button("重试") {
                    Task { await model.retry() }
                }
                .font(app.theme.current.font(.fs13, weight: .medium))
                .foregroundStyle(app.theme.current.accentDeep)
                .padding(.top, app.theme.current.space(.xs))
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, app.theme.current.space(.xxxl))
    }
}
