import SwiftUI

/// 「我」tab（PR-7 收尾域 devops#770，baseline §2.4 直译）：
/// 用户卡（头像/昵称/邮箱/会员标 + chevron → profile-edit）→ 手动同步行
/// （icon 转圈 syncing / 「上次同步 Xm ago」）→ 菜单五行（意见反馈带副标题
/// + 未读红点）。自定义顶栏升级为系统 inline 标题（mapping §3/D-rec-1 同族）。
public struct ProfileHomeView: View {

    @Environment(AppModel.self) private var model
    @State private var home = ProfileHomeModel()

    public init() {}

    public var body: some View {
        let theme = model.theme.current
        ScrollView {
            VStack(spacing: theme.space(.lg)) {
                userCard(theme)
                menuCard(theme)
            }
            .padding(theme.space(.lg))
        }
        .background(theme.background)
        .navigationTitle("我的")
        .inlineNavigationTitle()
        .raceToast(home.toastMessage) { home.toastMessage = nil }
        .task { await home.activate(app: model) }
        // onShow 场景之一：切回本 tab 静默刷新红点与上次同步（mapping §6.2）
        .onChange(of: model.router.selectedTab) { _, tab in
            if tab == .profile { Task { await home.refresh() } }
        }
        .onDisappear { home.cancelSync() }
    }

    // MARK: - 用户卡

    private func userCard(_ theme: any Theme) -> some View {
        Button {
            model.router.push(.profileEdit)
        } label: {
            HStack(spacing: theme.space(.md)) {
                avatar(theme)
                VStack(alignment: .leading, spacing: theme.space(.xs)) {
                    Text(home.name)
                        .font(theme.font(.fs15, weight: .medium))
                        .foregroundStyle(theme.foreground)
                    if !home.email.isEmpty {
                        Text(home.email)
                            .font(theme.font(.fs13))
                            .foregroundStyle(theme.muted)
                    }
                    if !home.tag.isEmpty {
                        Text(home.tag)
                            .font(theme.font(.fs11))
                            .foregroundStyle(theme.accentDeep)
                            .padding(.horizontal, theme.space(.sm))
                            .padding(.vertical, 2)
                            .background(Capsule().strokeBorder(theme.accent.opacity(0.5)))
                    }
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(theme.font(.fs13))
                    .foregroundStyle(theme.mutedTwo)
            }
            .padding(theme.space(.lg))
            .background(RoundedRectangle(cornerRadius: theme.radius(.lg)).fill(theme.surface))
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func avatar(_ theme: any Theme) -> some View {
        if let url = home.avatarURL.flatMap(URL.init(string:)) {
            AsyncImage(url: url) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                Circle().fill(theme.borderSoft)
            }
            .frame(width: 52, height: 52)
            .clipShape(Circle())
        } else {
            Image(systemName: "person.crop.circle.fill")
                .font(theme.font(.fsDisplay48))
                .foregroundStyle(theme.mutedTwo)
                .frame(width: 52, height: 52)
        }
    }

    // MARK: - 菜单（同步行 + 五行）

    private func menuCard(_ theme: any Theme) -> some View {
        VStack(spacing: 0) {
            syncRow(theme)
            ForEach(ProfileHomeModel.menuRows) { row in
                menuRow(row, theme: theme)
            }
        }
        .background(RoundedRectangle(cornerRadius: theme.radius(.lg)).fill(theme.surface))
        .clipShape(RoundedRectangle(cornerRadius: theme.radius(.lg)))
    }

    private func syncRow(_ theme: any Theme) -> some View {
        Button {
            Task { await home.startManualSync() }
        } label: {
            HStack(spacing: theme.space(.md)) {
                Group {
                    if home.syncing {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "arrow.triangle.2.circlepath")
                    }
                }
                .frame(width: 24, height: 24)
                .foregroundStyle(theme.accent)

                VStack(alignment: .leading, spacing: 2) {
                    Text(home.syncing ? "同步中..." : "手动同步数据")
                        .font(theme.font(.fs15))
                        .foregroundStyle(theme.foreground)
                    if !home.syncing {
                        Text(home.lastSyncText)
                            .font(theme.font(.fs12))
                            .foregroundStyle(theme.muted)
                    }
                }
                Spacer()
                if !home.syncing {
                    Image(systemName: "chevron.right")
                        .font(theme.font(.fs13))
                        .foregroundStyle(theme.mutedTwo)
                }
            }
            .padding(theme.space(.lg))
        }
        .buttonStyle(.plain)
        .disabled(home.syncing)
        .opacity(home.syncing ? 0.6 : 1)
    }

    private func menuRow(_ row: ProfileHomeModel.MenuRow, theme: any Theme) -> some View {
        Button {
            model.router.push(row.route)
        } label: {
            HStack(spacing: theme.space(.md)) {
                Image(systemName: row.systemImage)
                    .font(theme.font(.fs15))
                    .foregroundStyle(theme.accent)
                    .frame(width: 24, height: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title)
                        .font(theme.font(.fs15))
                        .foregroundStyle(theme.foreground)
                    if let subtitle = row.subtitle {
                        Text(subtitle)
                            .font(theme.font(.fs12))
                            .foregroundStyle(theme.muted)
                    }
                }
                Spacer()
                if row.id == "feedback", home.feedbackUnread > 0 {
                    Text(home.feedbackUnreadBadge)
                        .font(theme.font(.fs11, weight: .medium))
                        .foregroundStyle(theme.onAccent)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(theme.danger))
                }
                Image(systemName: "chevron.right")
                    .font(theme.font(.fs13))
                    .foregroundStyle(theme.mutedTwo)
            }
            .padding(theme.space(.lg))
        }
        .buttonStyle(.plain)
    }
}
