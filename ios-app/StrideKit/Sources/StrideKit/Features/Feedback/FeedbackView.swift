import SwiftUI

/// 意见反馈页（devops#554 原型 518 variant C，PR-7 收尾域）：
/// 双 tab（意见反馈默认 / 产品路线）——反馈 tab 会话行列表 + 右下悬浮 +
/// 球 CTA；路线 tab 为 RoadmapPanelView（首次挂载保活）；隐私脚注。
public struct FeedbackView: View {

    @Environment(AppModel.self) private var model
    @State private var feedback: FeedbackModel
    /// 首次 onAppear 与 activate 的首拉去重（activate 已在会话 settle 后拉过）。
    @State private var appearedOnce = false

    private let initialTab: FeedbackInitialTab?

    public init(initialTab: FeedbackInitialTab? = nil) {
        self.initialTab = initialTab
        _feedback = State(initialValue: FeedbackModel(initialTab: initialTab))
    }

    public var body: some View {
        let theme = model.theme.current
        ZStack(alignment: .bottomTrailing) {
            VStack(spacing: 0) {
                tabBar(theme)
                // 路线 tab hidden 切换不卸载（投票/滚动状态不丢）。
                ZStack {
                    if feedback.activeTab == .feedback {
                        feedbackTab(theme)
                    }
                    if feedback.roadmapMounted {
                        RoadmapPanelView()
                            .opacity(feedback.activeTab == .roadmap ? 1 : 0)
                            .allowsHitTesting(feedback.activeTab == .roadmap)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            // 右下悬浮 + 球 CTA（原型 518 variant C 同位）
            Button {
                model.router.push(.feedbackForm)
            } label: {
                Image(systemName: "plus")
                    .font(theme.font(.fs20, weight: .medium))
                    .foregroundStyle(theme.onAccent)
                    .frame(width: 48, height: 48)
                    .background(Circle().fill(theme.accent))
            }
            .accessibilityLabel("提交反馈")
            .padding(theme.space(.lg))
        }
        .background(theme.background)
        .navigationTitle("意见反馈")
        .inlineNavigationTitle()
        .task { await feedback.activate(app: model) }
        .onChange(of: model.router.selectedTab) { _, tab in
            // 回到本页重拉：从聊天页（读即清）返回后未读点自然消失。
            if tab == .profile { Task { await feedback.fetchList() } }
        }
        .onAppear {
            // 从 feedback-chat/form 返回时重拉（首进由 activate 覆盖）。
            guard appearedOnce else {
                appearedOnce = true
                return
            }
            Task { await feedback.fetchList() }
        }
    }

    private func tabBar(_ theme: any Theme) -> some View {
        HStack(spacing: 0) {
            tabButton(.feedback, label: "意见反馈", theme: theme)
            tabButton(.roadmap, label: "产品路线", theme: theme)
        }
        .padding(.horizontal, theme.space(.lg))
        .padding(.vertical, theme.space(.sm))
    }

    private func tabButton(_ tab: FeedbackModel.Tab, label: String, theme: any Theme) -> some View {
        let selected = feedback.activeTab == tab
        return Button {
            feedback.switchTab(tab)
        } label: {
            Text(label)
                .font(theme.font(.fs14, weight: selected ? .medium : .regular))
                .foregroundStyle(selected ? theme.accentDeep : theme.muted)
                .frame(maxWidth: .infinity)
                .padding(.vertical, theme.space(.sm))
                .background(
                    RoundedRectangle(cornerRadius: theme.radius(.sm))
                        .fill(selected ? theme.accent.opacity(0.12) : Color.clear)
                )
        }
        .buttonStyle(.plain)
    }

    // MARK: - 反馈 tab

    private func feedbackTab(_ theme: any Theme) -> some View {
        ScrollView {
            VStack(spacing: theme.space(.md)) {
                if feedback.loading {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(theme.space(.xl))
                } else if !feedback.loadError.isEmpty {
                    VStack(spacing: theme.space(.md)) {
                        Text(feedback.loadError)
                            .font(theme.font(.fs14))
                            .foregroundStyle(theme.muted)
                        Button("重试") {
                            Task { await feedback.fetchList() }
                        }
                        .font(theme.font(.fs14, weight: .medium))
                        .foregroundStyle(theme.accentDeep)
                    }
                    .padding(theme.space(.xl))
                } else if feedback.rows.isEmpty {
                    Text("还没有反馈，点右下角 + 提交第一条")
                        .font(theme.font(.fs14))
                        .foregroundStyle(theme.muted)
                        .padding(theme.space(.xl))
                } else {
                    ForEach(feedback.rows) { row in
                        convRow(row, theme: theme)
                    }
                }
                privacyFooter(theme)
            }
            .padding(theme.space(.lg))
        }
    }

    private func convRow(_ row: FeedbackConvRow, theme: any Theme) -> some View {
        Button {
            model.router.push(.feedbackChat(id: String(row.id)))
        } label: {
            HStack(alignment: .top, spacing: theme.space(.md)) {
                Text(row.emoji)
                    .font(theme.font(.fs20))
                    .frame(width: 36, height: 36)
                    .background(Circle().fill(theme.surface))
                VStack(alignment: .leading, spacing: theme.space(.xs)) {
                    HStack(spacing: theme.space(.sm)) {
                        Text(row.title)
                            .font(theme.font(.fs15, weight: .medium))
                            .foregroundStyle(theme.foreground)
                            .lineLimit(1)
                        if row.adopted {
                            // 已采纳角标 = 闭环手势：点角标切路线 tab。
                            Button {
                                feedback.switchTab(.roadmap)
                            } label: {
                                Text("已采纳")
                                    .font(theme.font(.fs10, weight: .medium))
                                    .foregroundStyle(theme.accentDeep)
                                    .padding(.horizontal, 5)
                                    .padding(.vertical, 1)
                                    .background(Capsule().strokeBorder(theme.accent.opacity(0.5)))
                            }
                            .buttonStyle(.plain)
                        }
                        Spacer()
                        Text(row.time)
                            .font(theme.font(.fs12))
                            .foregroundStyle(theme.mutedTwo)
                        if row.unread {
                            Circle().fill(theme.danger).frame(width: 8, height: 8)
                        }
                    }
                    Text(row.preview)
                        .font(theme.font(.fs13))
                        .foregroundStyle(theme.muted)
                        .lineLimit(1)
                }
            }
            .padding(theme.space(.lg))
            .background(RoundedRectangle(cornerRadius: theme.radius(.lg)).fill(theme.surface))
        }
        .buttonStyle(.plain)
    }

    private func privacyFooter(_ theme: any Theme) -> some View {
        Text("你的反馈只用于改进产品，回复会出现在这里")
            .font(theme.font(.fs12))
            .foregroundStyle(theme.mutedTwo)
            .frame(maxWidth: .infinity)
            .padding(.top, theme.space(.sm))
    }
}
