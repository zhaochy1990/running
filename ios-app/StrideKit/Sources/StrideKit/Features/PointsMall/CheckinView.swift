import SwiftUI

/// 每日签到页（devops#938，mp pages/checkin 直译；#851 原型变体 A）：
/// 粉渐变 hero（连签 N 天 + 副文案两态 + 「?」规则入口）→ 签到日程卡
/// （断签横幅 / D7 彩蛋横幅 / 周历收起-月历展开 / CTA）→ 我的积分卡
/// （余额 + 浮动 +N / 本轮已得 / 明细·商城链接）→ 签到成就卡（7 圆点）。
public struct CheckinView: View {

    @Environment(AppModel.self) private var model
    @State private var home: CheckinModel

    public init(gained: Int?) {
        _home = State(initialValue: CheckinModel(gained: gained))
    }

    public var body: some View {
        let theme = model.theme.current
        GeometryReader { _ in
            ScrollView {
                VStack(spacing: theme.space(.lg)) {
                    if home.loadFailed {
                        // 失败态保留 hero（基线 §14.1「hero 保留+重试」）。
                        heroCard(theme)
                        failedCard(theme)
                    } else {
                        content(theme)
                    }
                }
                .padding(theme.space(.lg))
            }
        }
        .background(theme.background)
        .navigationTitle("每日签到")
        .inlineNavigationTitle()
        .raceToast(home.toastMessage) { home.toastMessage = nil }
        .task { await home.activate(app: model) }
    }

    @ViewBuilder
    private func content(_ theme: any Theme) -> some View {
        if home.loading {
            ProgressView()
                .frame(maxWidth: .infinity)
                .padding(.vertical, theme.space(.xl))
        } else {
            heroCard(theme)
            scheduleCard(theme)
            pointsCard(theme)
            achievementCard(theme)
        }
    }

    private func failedCard(_ theme: any Theme) -> some View {
        VStack(spacing: theme.space(.md)) {
            Text("加载失败")
                .font(theme.font(.fs15, weight: .medium))
                .foregroundStyle(theme.muted)
            Button("重试") {
                Task { await home.load() }
            }
            .font(theme.font(.fs15, weight: .medium))
            .foregroundStyle(theme.accent)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, theme.space(.xl))
    }

    // MARK: - hero（头像圈 + 连签天数 + 副文案 + 规则「?」）

    private func heroCard(_ theme: any Theme) -> some View {
        VStack(alignment: .leading, spacing: theme.space(.sm)) {
            HStack(alignment: .top, spacing: theme.space(.md)) {
                heroAvatar(theme)
                VStack(alignment: .leading, spacing: 4) {
                    Text("我已经连续签到")
                        .font(theme.font(.fs13))
                        .foregroundStyle(theme.onAccent.opacity(0.9))
                    Text("\(home.streak) 天")
                        .font(theme.font(.fsDisplay40, weight: .bold))
                        .foregroundStyle(theme.onAccent)
                    Text(home.heroSub)
                        .font(theme.font(.fs12))
                        .foregroundStyle(theme.onAccent.opacity(0.85))
                }
                Spacer()
                Button {
                    home.showRules()
                } label: {
                    Text("?")
                        .font(theme.font(.fs15, weight: .medium))
                        .foregroundStyle(theme.onAccent)
                        .frame(width: 26, height: 26)
                        .background(Circle().strokeBorder(theme.onAccent.opacity(0.7)))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("签到规则")
            }
        }
        .padding(theme.space(.lg))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            LinearGradient(
                colors: [theme.accent, theme.accentDeep],
                startPoint: .topLeading, endPoint: .bottomTrailing
            )
            .clipShape(RoundedRectangle(cornerRadius: theme.radius(.lg)))
        )
    }

    /// hero 头像圈（白描边；无头像回落占位人像，mp checkin hero 同款）。
    @ViewBuilder
    private func heroAvatar(_ theme: any Theme) -> some View {
        Group {
            if let url = model.me?.avatarURL.flatMap(URL.init(string:)) {
                AsyncImage(url: url) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    Circle().fill(theme.onAccent.opacity(0.2))
                }
                .frame(width: 44, height: 44)
                .clipShape(Circle())
                .overlay(Circle().strokeBorder(theme.onAccent.opacity(0.6), lineWidth: 1.5))
            } else {
                Image(systemName: "person.crop.circle.fill")
                    .font(theme.font(.fsDisplay40))
                    .foregroundStyle(theme.onAccent.opacity(0.85))
                    .frame(width: 44, height: 44)
                    .overlay(Circle().strokeBorder(theme.onAccent.opacity(0.6), lineWidth: 1.5).frame(width: 44, height: 44))
            }
        }
    }

    // MARK: - 签到日程卡

    private func scheduleCard(_ theme: any Theme) -> some View {
        VStack(alignment: .leading, spacing: theme.space(.md)) {
            Text("签到日程｜本月已签 \(home.monthCheckedCount) 天")
                .font(theme.font(.fs15, weight: .medium))
                .foregroundStyle(theme.foreground)

            if home.showResetBanner {
                banner(text: "昨天没签到，连续天数已重置，今天签下开启新一轮", theme: theme)
            }
            if home.showWinBanner {
                banner(text: "🎉 集齐 7 天一轮，本轮 11 分到手！", theme: theme, win: true, pulse: home.winPulse)
            }

            monthGrid(theme)

            Button {
                home.monthOpen.toggle()
            } label: {
                Image(systemName: home.monthOpen ? "chevron.down.circle.fill" : "chevron.up.circle.fill")
                    .font(theme.font(.fs18))
                    .foregroundStyle(theme.mutedTwo)
                    .rotationEffect(.degrees(home.monthOpen ? 180 : 0))
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity)
            .accessibilityLabel(home.monthOpen ? "收起月历" : "展开月历")

            Button {
                Task { await home.checkIn() }
            } label: {
                Text(home.checking ? "签到中…" : home.ctaText)
                    .font(theme.font(.fs15, weight: .medium))
                    .foregroundStyle(theme.onAccent)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, theme.space(.md))
                    .background(Capsule().fill(theme.accent))
                    .opacity(home.canCheck && !home.checking ? 1 : 0.55)
            }
            .buttonStyle(.plain)
            .disabled(!home.canCheck || home.checking)
        }
        .padding(theme.space(.lg))
        .background(RoundedRectangle(cornerRadius: theme.radius(.lg)).fill(theme.surface))
    }

    private func banner(text: String, theme: any Theme, win: Bool = false, pulse: Bool = false) -> some View {
        Text(text)
            .font(theme.font(.fs12, weight: .medium))
            .foregroundStyle(win ? theme.onAccent : theme.foreground)
            .frame(maxWidth: .infinity)
            .padding(theme.space(.sm))
            .background(
                RoundedRectangle(cornerRadius: theme.radius(.md))
                    .fill(win ? theme.accent.opacity(0.9) : theme.accentTint.opacity(0.35))
            )
            .scaleEffect(pulse ? 1.03 : 1)
            .animation(pulse ? .easeInOut(duration: 0.45).repeatForever(autoreverses: true) : .default, value: pulse)
    }

    /// 周历/月历网格：周一起始 7 列；已签格 ✓+N、今天格粉描边、补位格灰。
    private func monthGrid(_ theme: any Theme) -> some View {
        let weekLabels = ["一", "二", "三", "四", "五", "六", "日"]
        return VStack(spacing: theme.space(.xs)) {
            HStack(spacing: 0) {
                ForEach(weekLabels, id: \.self) { label in
                    Text(label)
                        .font(theme.font(.fs11))
                        .foregroundStyle(theme.mutedTwo)
                        .frame(maxWidth: .infinity)
                }
            }
            ForEach(Array(home.visibleRows.enumerated()), id: \.offset) { _, row in
                HStack(spacing: 0) {
                    ForEach(row) { cell in
                        monthCell(cell, theme: theme)
                    }
                }
            }
        }
    }

    private func monthCell(_ cell: MonthCell, theme: any Theme) -> some View {
        VStack(spacing: 2) {
            Text(String(cell.label.split(separator: ".").last ?? ""))
                .font(theme.font(.fs12, weight: cell.state == .today ? .medium : .regular))
                .foregroundStyle(cellForeground(cell, theme: theme))
            if cell.state == .checked {
                Text("+\(cell.pts)")
                    .font(theme.font(.fs10))
                    .foregroundStyle(theme.accent)
            } else if cell.state == .today {
                Circle().fill(theme.accent)
                    .frame(width: 4, height: 4)
            } else {
                Text(" ")
                    .font(theme.font(.fs10))
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 4)
        .background(
            RoundedRectangle(cornerRadius: theme.radius(.md))
                .fill(cell.state == .today ? theme.accent.opacity(0.12) : .clear)
        )
        .overlay {
            if cell.state == .today {
                RoundedRectangle(cornerRadius: theme.radius(.md))
                    .strokeBorder(theme.accent, lineWidth: 1)
            }
        }
    }

    private func cellForeground(_ cell: MonthCell, theme: any Theme) -> Color {
        switch cell.state {
        case .checked: theme.foreground
        case .today: theme.accentDeep
        case .future: theme.muted
        case .missed: theme.mutedTwo
        case .other: theme.mutedTwo.opacity(0.5)
        }
    }

    // MARK: - 我的积分卡（余额 + 浮动 +N + 本轮已得 + 双链接）

    private func pointsCard(_ theme: any Theme) -> some View {
        VStack(spacing: theme.space(.md)) {
            HStack(alignment: .firstTextBaseline, spacing: theme.space(.xs)) {
                Text("\(home.balance)")
                    .font(theme.font(.fsDisplay40, weight: .bold))
                    .foregroundStyle(theme.foreground)
                    .contentTransition(.numericText())
                if home.justGained > 0 {
                    Text("+\(home.justGained)")
                        .font(theme.font(.fs15, weight: .bold))
                        .foregroundStyle(theme.accent)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
                Spacer()
                Text("分")
                    .font(theme.font(.fs13))
                    .foregroundStyle(theme.muted)
            }
            .animation(.easeOut(duration: 1.4), value: home.justGained)

            HStack(spacing: theme.space(.xl)) {
                Text("本轮已得 \(home.cycleEarned) 分")
                    .font(theme.font(.fs13))
                    .foregroundStyle(theme.muted)
                Spacer()
                Button("明细 ›") { model.router.push(.pointsDetail) }
                    .font(theme.font(.fs13, weight: .medium))
                    .foregroundStyle(theme.accentDeep)
                Button("积分商城 ›") { model.router.push(.pointsMall) }
                    .font(theme.font(.fs13, weight: .medium))
                    .foregroundStyle(theme.accentDeep)
            }
        }
        .padding(theme.space(.lg))
        .background(RoundedRectangle(cornerRadius: theme.radius(.lg)).fill(theme.surface))
    }

    // MARK: - 签到成就卡（7 圆点里程碑）

    private func achievementCard(_ theme: any Theme) -> some View {
        VStack(alignment: .leading, spacing: theme.space(.md)) {
            HStack {
                Text("签到成就")
                    .font(theme.font(.fs15, weight: .medium))
                    .foregroundStyle(theme.foreground)
                Spacer()
                Text("本轮签满 7 天共得 11 分")
                    .font(theme.font(.fs12))
                    .foregroundStyle(theme.muted)
            }
            HStack(spacing: 0) {
                ForEach(Array(home.milestones.enumerated()), id: \.offset) { _, ms in
                    VStack(spacing: 4) {
                        Text("\(ms.cum)")
                            .font(theme.font(.fs12, weight: .medium))
                            .foregroundStyle(ms.hit ? theme.onAccent : theme.muted)
                            .frame(width: 30, height: 30)
                            .background(Circle().fill(ms.hit ? theme.accent : theme.borderSoft))
                        Text(ms.label)
                            .font(theme.font(.fs10))
                            .foregroundStyle(theme.mutedTwo)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
        }
        .padding(theme.space(.lg))
        .background(RoundedRectangle(cornerRadius: theme.radius(.lg)).fill(theme.surface))
    }
}

/// 规则弹窗（签到/商城两份共用形态：滚动正文 + 「知道了」关闭）。
public struct RulesSheet: View {
    @Environment(AppModel.self) private var app
    let document: RulesDocument
    let onClose: () -> Void

    public var body: some View {
        let theme = app.theme.current
        VStack(spacing: 0) {
            Text(document.title)
                .font(theme.font(.fs15, weight: .bold))
                .foregroundStyle(theme.foreground)
                .padding(.top, theme.space(.lg))
                .padding(.bottom, theme.space(.sm))
            ScrollView {
                VStack(alignment: .leading, spacing: theme.space(.sm)) {
                    ForEach(document.blocks) { block in
                        switch block.kind {
                        case .heading:
                            Text(block.text)
                                .font(theme.font(.fs13, weight: .bold))
                                .foregroundStyle(theme.foreground)
                                .padding(.top, theme.space(.xs))
                        case .paragraph:
                            Text(block.text)
                                .font(theme.font(.fs12))
                                .foregroundStyle(theme.muted)
                        case .tip:
                            Text(block.text)
                                .font(theme.font(.fs12))
                                .foregroundStyle(theme.accentDeep)
                                .padding(theme.space(.sm))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(
                                    RoundedRectangle(cornerRadius: theme.radius(.md))
                                        .fill(theme.accentTint.opacity(0.3))
                                )
                        }
                    }
                }
                .padding(.horizontal, theme.space(.lg))
                .padding(.bottom, theme.space(.lg))
            }
            Button("知道了", action: onClose)
                .font(theme.font(.fs15, weight: .medium))
                .foregroundStyle(theme.onAccent)
                .frame(maxWidth: .infinity)
                .padding(.vertical, theme.space(.md))
                .background(Capsule().fill(theme.accent))
                .padding(.horizontal, theme.space(.lg))
                .padding(.bottom, theme.space(.lg))
        }
        .background(theme.surface)
        .clipShape(RoundedRectangle(cornerRadius: theme.radius(.lg)))
        .padding(theme.space(.lg))
    }
}
