import SwiftUI

/// 教练对话分享阅读端（#624 D 变体，浅色气泡流）：用户浅粉右气泡 / 教练
/// 白底 markdown 左气泡 / 策略卡静态摘要降级 / 底部品牌条常驻。
/// 410 过期 / 404 不存在各出空态，429/5xx/网络失败可重试。
public struct CoachShareView: View {

    @Environment(AppModel.self) private var model
    @State private var share: CoachShareModel

    public init(sid: String) {
        _share = State(initialValue: CoachShareModel(sid: sid))
    }

    public var body: some View {
        let theme = model.theme.current
        VStack(spacing: 0) {
            ScrollView {
                Group {
                    switch share.loadState {
                    case .loading:
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            .padding(theme.space(.xl))
                    case .expired:
                        emptyCard("该分享已过期（30 天有效）", systemImage: "clock.badge.exclamationmark", theme: theme)
                    case .notfound:
                        emptyCard("分享不存在或已删除", systemImage: "questionmark.folder", theme: theme)
                    case .error:
                        VStack(spacing: theme.space(.md)) {
                            emptyCard("加载失败，请稍后重试", systemImage: "wifi.exclamationmark", theme: theme)
                            Button("重试") {
                                Task { await share.load() }
                            }
                            .font(theme.font(.fs14, weight: .medium))
                            .foregroundStyle(theme.accentDeep)
                        }
                    case .ready:
                        bubbleFlow(theme)
                    }
                }
                .padding(theme.space(.lg))
            }
            brandBar(theme)
        }
        .background(theme.background)
        .navigationTitle(share.loadState == .ready ? share.title : "教练对话")
        .inlineNavigationTitle()
        .task { await share.activate(app: model) }
    }

    private func emptyCard(_ text: String, systemImage: String, theme: any Theme) -> some View {
        VStack(spacing: theme.space(.md)) {
            Image(systemName: systemImage)
                .font(theme.font(.fsDisplay40))
                .foregroundStyle(theme.mutedTwo)
            Text(text)
                .font(theme.font(.fs14))
                .foregroundStyle(theme.muted)
        }
        .frame(maxWidth: .infinity)
        .padding(theme.space(.xl))
    }

    private func bubbleFlow(_ theme: any Theme) -> some View {
        VStack(alignment: .leading, spacing: theme.space(.md)) {
            if !share.meta.isEmpty {
                Text(share.meta)
                    .font(theme.font(.fs12))
                    .foregroundStyle(theme.mutedTwo)
                    .frame(maxWidth: .infinity)
            }
            ForEach(share.messages) { message in
                bubble(message, theme: theme)
            }
        }
    }

    @ViewBuilder
    private func bubble(_ message: CoachShareMessageRow, theme: any Theme) -> some View {
        HStack(alignment: .top, spacing: theme.space(.sm)) {
            if message.role == .user { Spacer(minLength: 56) }
            VStack(alignment: message.role == .user ? .trailing : .leading, spacing: theme.space(.xs)) {
                if message.role == .assistant {
                    Text("StrideWise")
                        .font(theme.font(.fs11, weight: .medium))
                        .foregroundStyle(theme.mutedTwo)
                }
                if let card = message.card {
                    cardHead(card, theme: theme)
                }
                if message.rendersMarkdown {
                    MarkdownText(message.content, theme: theme)
                        .padding(theme.space(.md))
                        .background(
                            RoundedRectangle(cornerRadius: theme.radius(.md))
                                .fill(message.role == .user ? theme.accent.opacity(0.12) : theme.surface)
                        )
                }
            }
            if message.role == .assistant { Spacer(minLength: 56) }
        }
    }

    private func cardHead(_ card: CoachShareCardView, theme: any Theme) -> some View {
        HStack(spacing: theme.space(.sm)) {
            Image(systemName: card.icon)
                .font(theme.font(.fs14))
                .foregroundStyle(theme.accent)
            VStack(alignment: .leading, spacing: 2) {
                Text(card.title)
                    .font(theme.font(.fs13, weight: .medium))
                    .foregroundStyle(theme.foreground)
                if !card.subtitle.isEmpty {
                    Text(card.subtitle)
                        .font(theme.font(.fs12))
                        .foregroundStyle(theme.muted)
                }
            }
            Spacer()
        }
        .padding(theme.space(.md))
        .background(RoundedRectangle(cornerRadius: theme.radius(.md)).strokeBorder(theme.accent.opacity(0.4)))
    }

    /// 底部品牌条常驻：wxacode 码图 fail-soft（空回退品牌占位块）。
    private func brandBar(_ theme: any Theme) -> some View {
        HStack(spacing: theme.space(.md)) {
            Group {
                if let url = URL(string: share.wxacodeURL), !share.wxacodeURL.isEmpty {
                    AsyncImage(url: url) { image in
                        image.resizable().scaledToFill()
                    } placeholder: {
                        Rectangle().fill(theme.borderSoft)
                    }
                    .frame(width: 40, height: 40)
                    .clipShape(RoundedRectangle(cornerRadius: theme.radius(.sm)))
                } else {
                    RoundedRectangle(cornerRadius: theme.radius(.sm))
                        .fill(theme.accent.opacity(0.15))
                        .frame(width: 40, height: 40)
                        .overlay {
                            Text("S")
                                .font(theme.font(.fs15, weight: .bold))
                                .foregroundStyle(theme.accent)
                        }
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                Text("STRIDE 跑步教练")
                    .font(theme.font(.fs13, weight: .medium))
                    .foregroundStyle(theme.foreground)
                Text("AI 训练计划 · 比赛策略")
                    .font(theme.font(.fs11))
                    .foregroundStyle(theme.muted)
            }
            Spacer()
        }
        .padding(theme.space(.lg))
        .background(theme.surface)
    }
}

/// 比赛策略只读分享落地页（#506）：hero（赛名/项目/比赛日/目标成绩/目标配速）
/// → summary → 五列配速表 → 补给 → 打包清单 → 赛道/天气提示 → 制定依据 →
/// 底部 CTA「生成我的比赛策略」；失效态文案。
public struct StrategyShareView: View {

    @Environment(AppModel.self) private var model
    @State private var share: StrategyShareModel

    public init(user: String, id: Int, version: Int) {
        _share = State(initialValue: StrategyShareModel(user: user, id: id, version: version))
    }

    public var body: some View {
        let theme = model.theme.current
        VStack(spacing: 0) {
            ScrollView {
                Group {
                    switch share.loadState {
                    case .loading:
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            .padding(theme.space(.xl))
                    case .dead:
                        deadCard(theme)
                    case .error:
                        VStack(spacing: theme.space(.md)) {
                            deadCard(theme)
                            Button("重试") {
                                Task { await share.refresh() }
                            }
                            .font(theme.font(.fs14, weight: .medium))
                            .foregroundStyle(theme.accentDeep)
                        }
                    case .ready:
                        if let view = share.view {
                            content(view, theme: theme)
                        }
                    }
                }
                .padding(theme.space(.lg))
            }
            if share.loadState == .ready {
                Button {
                    share.generateTap()
                } label: {
                    Text("生成我的比赛策略")
                        .font(theme.font(.fs15, weight: .medium))
                        .foregroundStyle(theme.onAccent)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, theme.space(.md))
                        .background(theme.accent)
                }
                .padding(theme.space(.lg))
            }
        }
        .background(theme.background)
        .navigationTitle("比赛策略")
        .inlineNavigationTitle()
        .task { await share.activate(app: model) }
    }

    private func deadCard(_ theme: any Theme) -> some View {
        VStack(spacing: theme.space(.md)) {
            Image(systemName: "flag.slash")
                .font(theme.font(.fsDisplay40))
                .foregroundStyle(theme.mutedTwo)
            Text("该分享已失效")
                .font(theme.font(.fs15))
                .foregroundStyle(theme.muted)
        }
        .frame(maxWidth: .infinity)
        .padding(theme.space(.xl))
    }

    private func content(_ view: StrategyViewData, theme: any Theme) -> some View {
        VStack(alignment: .leading, spacing: theme.space(.lg)) {
            // hero
            VStack(alignment: .leading, spacing: theme.space(.xs)) {
                HStack(spacing: theme.space(.sm)) {
                    Text(view.itemTypeLabel)
                        .font(theme.font(.fs12, weight: .medium))
                        .foregroundStyle(theme.accentDeep)
                        .padding(.horizontal, theme.space(.sm))
                        .padding(.vertical, 3)
                        .background(Capsule().strokeBorder(theme.accent.opacity(0.5)))
                    if !share.raceDayText.isEmpty {
                        Text(share.raceDayText)
                            .font(theme.font(.fs12))
                            .foregroundStyle(theme.muted)
                    }
                }
                Text(view.raceName)
                    .font(theme.font(.fs22, weight: .bold))
                    .foregroundStyle(theme.foreground)
                HStack(alignment: .firstTextBaseline, spacing: theme.space(.sm)) {
                    Text("目标 \(view.targetTime)")
                        .font(theme.font(.fs18, weight: .bold))
                        .foregroundStyle(theme.accent)
                    if !view.targetPace.isEmpty {
                        Text(view.targetPace)
                            .font(theme.font(.fs13))
                            .foregroundStyle(theme.muted)
                    }
                }
            }

            if !view.summary.isEmpty {
                Text(view.summary)
                    .font(theme.font(.fs14))
                    .foregroundStyle(theme.foreground)
                    .padding(theme.space(.md))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: theme.radius(.md)).fill(theme.surface))
            }

            if !view.paceRows.isEmpty {
                section("配速表", theme: theme) {
                    VStack(spacing: 0) {
                        ForEach(view.paceRows) { row in
                            VStack(alignment: .leading, spacing: 2) {
                                HStack {
                                    Text(row.distance)
                                        .font(theme.font(.fs13, weight: .medium))
                                        .foregroundStyle(theme.foreground)
                                    Spacer()
                                    Text(row.pace)
                                        .font(theme.font(.fs13, mono: true))
                                        .foregroundStyle(theme.accent)
                                    Text(row.segmentTime)
                                        .font(theme.font(.fs13, mono: true))
                                        .foregroundStyle(theme.foreground)
                                    Text(row.cumulativeTime)
                                        .font(theme.font(.fs13, mono: true))
                                        .foregroundStyle(theme.muted)
                                }
                                if !row.desc.isEmpty || !row.note.isEmpty {
                                    Text([row.desc, row.note].filter { !$0.isEmpty }.joined(separator: " · "))
                                        .font(theme.font(.fs12))
                                        .foregroundStyle(theme.mutedTwo)
                                }
                            }
                            .padding(.vertical, theme.space(.xs))
                        }
                    }
                    .padding(theme.space(.md))
                    .background(RoundedRectangle(cornerRadius: theme.radius(.md)).fill(theme.surface))
                }
            }

            if !view.fuelingRows.isEmpty {
                section("补给计划", theme: theme) {
                    VStack(spacing: theme.space(.xs)) {
                        ForEach(view.fuelingRows) { row in
                            HStack {
                                Text(row.timePoint)
                                    .font(theme.font(.fs13, mono: true))
                                    .foregroundStyle(theme.muted)
                                Text(row.content)
                                    .font(theme.font(.fs13))
                                    .foregroundStyle(theme.foreground)
                                Spacer()
                            }
                        }
                    }
                    .padding(theme.space(.md))
                    .background(RoundedRectangle(cornerRadius: theme.radius(.md)).fill(theme.surface))
                }
            }

            if !view.checklistRows.isEmpty {
                section("补给打包清单", theme: theme) {
                    VStack(spacing: theme.space(.xs)) {
                        ForEach(view.checklistRows) { row in
                            HStack {
                                Text("\(row.item) ×\(row.count)")
                                    .font(theme.font(.fs13, weight: .medium))
                                    .foregroundStyle(theme.foreground)
                                Spacer()
                                Text(row.note)
                                    .font(theme.font(.fs12))
                                    .foregroundStyle(theme.mutedTwo)
                            }
                        }
                    }
                    .padding(theme.space(.md))
                    .background(RoundedRectangle(cornerRadius: theme.radius(.md)).fill(theme.surface))
                }
            }

            if !view.courseTips.isEmpty {
                section("赛道提示", theme: theme) {
                    VStack(alignment: .leading, spacing: theme.space(.xs)) {
                        ForEach(view.courseTips, id: \.self) { tip in
                            Label(tip, systemImage: "point.topleft.down.curvedto.point.bottomright.up")
                                .font(theme.font(.fs13))
                                .foregroundStyle(theme.muted)
                        }
                    }
                }
            }

            if !view.weatherTips.isEmpty {
                section("天气提示", theme: theme) {
                    VStack(alignment: .leading, spacing: theme.space(.xs)) {
                        // StrategyViewData 将多条天气提示以换行拼接，逐行恢复展示。
                        ForEach(Array(view.weatherTips.split(separator: "\n").enumerated()), id: \.offset) { _, tip in
                            Label(String(tip), systemImage: "cloud.sun")
                                .font(theme.font(.fs13))
                                .foregroundStyle(theme.muted)
                        }
                    }
                }
            }

            if !view.basisNote.isEmpty {
                section("制定依据", theme: theme) {
                    MarkdownText(view.basisNote, theme: theme)
                }
            }
        }
    }

    private func section<Content: View>(_ title: String, theme: any Theme, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: theme.space(.sm)) {
            Text(title)
                .font(theme.font(.fs13, weight: .bold))
                .foregroundStyle(theme.muted)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
