import SwiftUI

/// 反馈线程聊天页（devops#554 原型 518 variant C）：chat-head（类型/状态
/// tag + 已采纳 tag）→ 已采纳横幅（🏆 + 去投票 › → product-roadmap）→
/// 首卡（原文 + 图片九宫格全屏查看 + 时间）→ 气泡流（官方左「STRIDE 团队」
/// / 本人右）→ 常驻输入条（草稿非空点亮）；closed 禁言条替代输入。
public struct FeedbackChatView: View {

    @Environment(AppModel.self) private var model
    @State private var chat: FeedbackChatModel
    @State private var previewURLs: [String] = []
    @State private var previewIndex = 0
    @State private var showPreview = false
    @FocusState private var draftFocused: Bool

    public init(feedbackId: Int) {
        _chat = State(initialValue: FeedbackChatModel(feedbackId: feedbackId))
    }

    public var body: some View {
        let theme = model.theme.current
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: theme.space(.md)) {
                        if chat.loading {
                            ProgressView()
                                .frame(maxWidth: .infinity)
                                .padding(theme.space(.xl))
                        } else if !chat.loadError.isEmpty {
                            errorCard(theme)
                        } else {
                            head(theme)
                            if chat.head.adopted { adoptedBanner(theme) }
                            firstCard(theme)
                            bubbleFlow(theme, proxy: proxy)
                        }
                    }
                    .padding(theme.space(.lg))
                }
            }
            inputBar(theme)
        }
        .background(theme.background)
        .navigationTitle("反馈详情")
        .inlineNavigationTitle()
        .raceToast(chat.toastMessage) { chat.toastMessage = nil }
        .task { await chat.activate(app: model) }
        .platformFullScreen(isPresented: $showPreview) {
            URLViewer(urls: chat.imageUrls, index: previewIndex)
        }
    }

    private func errorCard(_ theme: any Theme) -> some View {
        VStack(spacing: theme.space(.md)) {
            Text(chat.loadError)
                .font(theme.font(.fs14))
                .foregroundStyle(theme.muted)
            Button("重试") {
                Task { await chat.fetchThread() }
            }
            .font(theme.font(.fs14, weight: .medium))
            .foregroundStyle(theme.accentDeep)
        }
        .padding(theme.space(.xl))
    }

    private func head(_ theme: any Theme) -> some View {
        HStack(spacing: theme.space(.sm)) {
            Text("\(chat.head.typeEmoji) \(chat.head.typeLabel)")
                .font(theme.font(.fs12, weight: .medium))
                .foregroundStyle(chat.head.typeLabel == "Bug 反馈" ? theme.warning : theme.accentDeep)
                .padding(.horizontal, theme.space(.sm))
                .padding(.vertical, 3)
                .background(Capsule().strokeBorder(theme.border))
            Text(chat.head.statusLabel)
                .font(theme.font(.fs12, weight: .medium))
                .foregroundStyle(theme.muted)
                .padding(.horizontal, theme.space(.sm))
                .padding(.vertical, 3)
                .background(Capsule().strokeBorder(theme.borderSoft))
            if chat.head.adopted {
                Text("已采纳")
                    .font(theme.font(.fs12, weight: .medium))
                    .foregroundStyle(theme.onAccent)
                    .padding(.horizontal, theme.space(.sm))
                    .padding(.vertical, 3)
                    .background(Capsule().fill(theme.accent))
            }
            Spacer()
        }
    }

    private func adoptedBanner(_ theme: any Theme) -> some View {
        Button {
            model.router.push(.productRoadmap)
        } label: {
            HStack(spacing: theme.space(.sm)) {
                Text("🏆")
                VStack(alignment: .leading, spacing: 2) {
                    Text("已采纳")
                        .font(theme.font(.fs13, weight: .medium))
                        .foregroundStyle(theme.foreground)
                    if !chat.adoptedTitle.isEmpty {
                        Text(chat.adoptedTitle)
                            .font(theme.font(.fs12))
                            .foregroundStyle(theme.muted)
                            .lineLimit(1)
                    }
                }
                Spacer()
                Text("去投票 ›")
                    .font(theme.font(.fs13, weight: .medium))
                    .foregroundStyle(theme.accentDeep)
            }
            .padding(theme.space(.lg))
            .background(RoundedRectangle(cornerRadius: theme.radius(.md)).fill(theme.accent.opacity(0.08)))
        }
        .buttonStyle(.plain)
    }

    private func firstCard(_ theme: any Theme) -> some View {
        VStack(alignment: .leading, spacing: theme.space(.md)) {
            Text(chat.content)
                .font(theme.font(.fs15))
                .foregroundStyle(theme.foreground)
            if !chat.imageUrls.isEmpty {
                let columns = Array(repeating: GridItem(.flexible(), spacing: theme.space(.xs)), count: 3)
                LazyVGrid(columns: columns, spacing: theme.space(.xs)) {
                    ForEach(Array(chat.imageUrls.enumerated()), id: \.offset) { index, urlString in
                        AsyncImage(url: URL(string: urlString)) { image in
                            image.resizable().scaledToFill()
                        } placeholder: {
                            Rectangle().fill(theme.borderSoft)
                        }
                        .frame(height: 96)
                        .clipShape(RoundedRectangle(cornerRadius: theme.radius(.sm)))
                        .onTapGesture {
                            previewIndex = index
                            showPreview = true
                        }
                    }
                }
            }
            Text(chat.time)
                .font(theme.font(.fs12))
                .foregroundStyle(theme.mutedTwo)
        }
        .padding(theme.space(.lg))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: theme.radius(.lg)).fill(theme.surface))
    }

    private func bubbleFlow(_ theme: any Theme, proxy: ScrollViewProxy) -> some View {
        VStack(spacing: theme.space(.md)) {
            ForEach(chat.bubbles) { bubble in
                HStack(alignment: .top, spacing: theme.space(.sm)) {
                    if bubble.mine { Spacer(minLength: 48) }
                    if !bubble.mine {
                        Text("STRIDE 团队")
                            .font(theme.font(.fs12))
                            .foregroundStyle(theme.mutedTwo)
                            .frame(width: 48, alignment: .leading)
                    }
                    VStack(alignment: bubble.mine ? .trailing : .leading, spacing: 4) {
                        Text(bubble.text)
                            .font(theme.font(.fs14))
                            .foregroundStyle(theme.foreground)
                            .padding(theme.space(.md))
                            .background(
                                RoundedRectangle(cornerRadius: theme.radius(.md))
                                    .fill(bubble.mine ? theme.accent.opacity(0.14) : theme.surface)
                            )
                        Text(bubble.time)
                            .font(theme.font(.fs11))
                            .foregroundStyle(theme.mutedTwo)
                    }
                    if !bubble.mine { Spacer(minLength: 48) }
                }
                .id("bubble-\(bubble.id)")
            }
        }
        .onChange(of: chat.bubbles.count) { _, count in
            if let last = chat.bubbles.last, count > 0 {
                withAnimation {
                    proxy.scrollTo("bubble-\(last.id)", anchor: .bottom)
                }
            }
        }
        .onAppear {
            if let last = chat.bubbles.last {
                proxy.scrollTo("bubble-\(last.id)", anchor: .bottom)
            }
        }
    }

    private func inputBar(_ theme: any Theme) -> some View {
        Group {
            if chat.closed {
                HStack(spacing: theme.space(.md)) {
                    Text("该反馈已关闭，如有问题请提交新反馈")
                        .font(theme.font(.fs13))
                        .foregroundStyle(theme.muted)
                    Spacer()
                    Button("提交新反馈") {
                        model.router.push(.feedbackForm)
                    }
                    .font(theme.font(.fs13, weight: .medium))
                    .foregroundStyle(theme.accentDeep)
                }
                .padding(theme.space(.lg))
                .background(theme.surface)
            } else {
                HStack(spacing: theme.space(.md)) {
                    TextField("补充说明…", text: $chat.draft, axis: .vertical)
                        .font(theme.font(.fs14))
                        .foregroundStyle(theme.foreground)
                        .lineLimit(1...4)
                        .padding(theme.space(.md))
                        .background(RoundedRectangle(cornerRadius: theme.radius(.md)).fill(theme.surface))
                        .focused($draftFocused)
                    Button {
                        Task {
                            draftFocused = false
                            await chat.send()
                        }
                    } label: {
                        if chat.sending {
                            ProgressView()
                        } else {
                            Text("发送")
                                .font(theme.font(.fs14, weight: .medium))
                        }
                    }
                    .foregroundStyle(chat.canSend ? theme.accent : theme.mutedTwo)
                    .disabled(!chat.canSend)
                }
                .padding(theme.space(.lg))
                .background(theme.background)
            }
        }
    }
}

/// 图片全屏查看器（previewImage 的 D-9 对等）。
private struct URLViewer: View {
    let urls: [String]
    let index: Int
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            TabView(selection: .constant(index)) {
                ForEach(Array(urls.enumerated()), id: \.offset) { _, urlString in
                    AsyncImage(url: URL(string: urlString)) { image in
                        image.resizable().scaledToFit()
                    } placeholder: {
                        ProgressView().tint(.white)
                    }
                    .tag(index)
                }
            }
            .pageTabStyleCompat()
            .background(Color.black)
            .toolbar {
                ToolbarItem(placement: .navigation) {
                    Button("关闭") { dismiss() }
                        .foregroundStyle(.white)
                }
            }
        }
    }
}
