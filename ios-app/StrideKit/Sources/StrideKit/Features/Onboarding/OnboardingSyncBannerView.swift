import SwiftUI

/// 全局首次同步 banner（devops#1016 / epic #1004 T12；Web
/// OnboardingSyncBanner 的 SwiftUI 等价）：挂在 loggedIn 根容器，首页/
/// 记录/训练/我所有页面同一份服务端派生进度。
///
/// 近期详情在 recent_data ready 即可查看——之后的历史失败不收回它们；
/// failed / completed_with_gaps 保留展示（错误 + 重试 / 缺项说明），
/// completed / superseded 隐藏。收起状态与 Web 同 key 持久化。
public struct OnboardingSyncBannerView: View {

    @Environment(AppModel.self) private var appModel
    @Bindable var model: OnboardingSyncStatusModel
    @State private var expanded: Bool

    /// 与 Web localStorage 同 key（跨端排查能对上）。
    static let collapsedKey = "stride.onboarding-sync-banner.collapsed"

    public init(model: OnboardingSyncStatusModel) {
        self.model = model
        _expanded = State(initialValue: UserDefaults.standard.string(forKey: Self.collapsedKey) != "1")
    }

    public var body: some View {
        let theme = appModel.theme.current
        let view = model.view
        let failed = view?.state == "failed"
        let gapsTerminal = view?.state == "completed_with_gaps"

        VStack(alignment: .leading, spacing: theme.space(.sm)) {
            header(theme: theme, failed: failed, gapsTerminal: gapsTerminal)
            if expanded {
                detail(theme: theme, failed: failed)
            }
        }
        .padding(.horizontal, theme.space(.md))
        .padding(.vertical, theme.space(.sm))
        .background(
            failed ? theme.danger.opacity(0.06) : (gapsTerminal ? theme.warning.opacity(0.08) : theme.surface)
        )
        .overlay(alignment: .bottom) {
            Rectangle().fill(theme.borderSoft).frame(height: 0.5)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("首次数据同步状态")
    }

    // MARK: - 头部（状态 + 汇总 chips + 动作）

    @ViewBuilder
    private func header(theme: any Theme, failed: Bool, gapsTerminal: Bool) -> some View {
        let view = model.view
        VStack(alignment: .leading, spacing: theme.space(.xs)) {
            HStack(spacing: theme.space(.sm)) {
                Circle()
                    .fill(failed ? theme.danger : (gapsTerminal ? theme.warning : theme.accent))
                    .frame(width: 7, height: 7)
                Text("首次数据同步 · \(view.map { OnboardingSessionDisplay.stateLabel($0.state) } ?? "")")
                    .font(theme.font(.fs13, weight: .medium))
                    .foregroundStyle(theme.foreground)
                Spacer()
                actions(theme: theme, failed: failed, gapsTerminal: gapsTerminal)
            }
            if let readiness = view?.readiness {
                // 原始/派生/辅助分开；shell_ready 是 bool 不做 chip（spec 决议）
                FlowLayout(spacing: 4) {
                    ForEach(OnboardingSessionDisplay.ReadinessKey.allCases, id: \.self) { key in
                        readinessChip(label: key.label,
                                      level: OnboardingSessionDisplay.readinessLevel(key, of: readiness),
                                      theme: theme)
                    }
                }
            }
        }
    }

    private func readinessChip(label: String, level: OnboardingSyncReadiness, theme: any Theme) -> some View {
        let color = toneColor(OnboardingSessionDisplay.readinessTone(level), theme: theme)
        return HStack(spacing: 3) {
            Text(label).foregroundStyle(theme.muted)
            Text(OnboardingSessionDisplay.readinessLabel(level)).foregroundStyle(color)
        }
        .font(theme.font(.fs11))
        .padding(.horizontal, 5)
        .padding(.vertical, 2)
        .background(Capsule().stroke(color.opacity(0.5)))
    }

    @ViewBuilder
    private func actions(theme: any Theme, failed: Bool, gapsTerminal: Bool) -> some View {
        HStack(spacing: theme.space(.md)) {
            if recentReady {
                // 后台失败不收回近期数据：recent_data 就绪即保持入口（spec/Web 同口径）
                Button("查看近期活动") {
                    appModel.router.selectedTab = .activities
                }
                .font(theme.font(.fs12))
                .foregroundStyle(theme.accentDeep)
            }
            if failed {
                Button(model.retrying ? "重试中…" : "重试失败项") {
                    Task { await model.retry() }
                }
                .font(theme.font(.fs12))
                .foregroundStyle(theme.danger)
                .disabled(model.retrying)
            }
            if failed || gapsTerminal {
                Button("忽略") { model.dismiss() }
                    .font(theme.font(.fs12))
                    .foregroundStyle(theme.muted)
            }
            Button(expanded ? "收起" : "展开") {
                expanded.toggle()
                UserDefaults.standard.set(expanded ? "0" : "1", forKey: Self.collapsedKey)
            }
            .font(theme.font(.fs12))
            .foregroundStyle(theme.muted)
        }
        .buttonStyle(.plain)
    }

    private var recentReady: Bool {
        guard let level = model.view?.readiness.recentData else { return false }
        return level == .ready || level == .readyWithGaps
    }

    // MARK: - 展开详情（阶段覆盖 / 缺项 / 错误）

    @ViewBuilder
    private func detail(theme: any Theme, failed: Bool) -> some View {
        let view = model.view
        VStack(alignment: .leading, spacing: theme.space(.xs)) {
            if failed || view?.error != nil {
                Text(view?.error ?? "部分同步任务失败，已完成的范围不会丢失。")
                    .font(theme.font(.fs11))
                    .foregroundStyle(theme.danger)
            }
            if let retryError = model.retryError {
                Text(retryError)
                    .font(theme.font(.fs11))
                    .foregroundStyle(theme.danger)
            }
            if let stages = view?.stages {
                ForEach(stages, id: \.stage) { stage in
                    stageRow(stage, theme: theme)
                }
            }
            Text("退出 App 或关闭页面不会中断同步；换设备登录后进度保持不变。近期训练详情在「近期数据」就绪后即可查看，历史补齐失败不影响近期数据。")
                .font(theme.font(.fs11))
                .foregroundStyle(theme.muted)
        }
    }

    @ViewBuilder
    private func stageRow(_ stage: OnboardingSyncStageView, theme: any Theme) -> some View {
        let color = toneColor(OnboardingSessionDisplay.readinessTone(stage.readiness), theme: theme)
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(OnboardingSessionDisplay.stageLabel(stage.stage))
                    .font(theme.font(.fs12, weight: .medium))
                    .foregroundStyle(theme.foreground)
                Spacer()
                Text(OnboardingSessionDisplay.readinessLabel(stage.readiness))
                    .font(theme.font(.fs11))
                    .foregroundStyle(color)
            }
            Text("目标范围 \(OnboardingSessionDisplay.rangeLabel(from: stage.targetFrom, to: stage.targetTo))"
                 + " · 实际覆盖 \(OnboardingSessionDisplay.rangeLabel(from: stage.observedFrom, to: stage.observedTo))")
                .font(theme.font(.fs11))
                .foregroundStyle(theme.muted)
            if let gaps = stage.gaps, !gaps.isEmpty {
                // 缺项如实列出（合法缺测/失败原因），不冒充完整覆盖
                Text("缺项：" + gaps.map { gap in
                    OnboardingSessionDisplay.rangeLabel(from: gap.from, to: gap.to)
                        + (gap.reason.map { "（\($0)）" } ?? "")
                }.joined(separator: "、"))
                    .font(theme.font(.fs11))
                    .foregroundStyle(theme.warning)
            }
            if let error = stage.error {
                Text(error)
                    .font(theme.font(.fs11))
                    .foregroundStyle(theme.danger)
            }
        }
        .padding(.horizontal, theme.space(.sm))
        .padding(.vertical, theme.space(.xs))
        .background(RoundedRectangle(cornerRadius: theme.radius(.sm)).fill(theme.background))
        .overlay(RoundedRectangle(cornerRadius: theme.radius(.sm)).stroke(theme.borderSoft))
    }

    private func toneColor(_ tone: OnboardingSessionDisplay.Tone, theme: any Theme) -> Color {
        switch tone {
        case .good: theme.accent
        case .warn: theme.warning
        case .bad: theme.danger
        case .muted: theme.muted
        }
    }
}

/// 简易换行流式布局（SwiftUI Layout 协议）：chips 数量固定且短，本实现
/// 只做水平排布 + 溢出换行，不做对齐微调。
private struct FlowLayout: Layout {

    var spacing: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > maxWidth {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: proposal.width ?? x, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
