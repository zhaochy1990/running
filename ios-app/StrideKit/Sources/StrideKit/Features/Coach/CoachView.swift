import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

// devops#767 PR-4：教练 tab 全链（MP pages/coach/coach.{ts,wxml} 的 SwiftUI 镜像）。
// 顶栏汉堡→会话抽屉（底部 sheet）；上下文提示条；消息流（欢迎语/markdown+
// 常驻复制/流式打字机）；四型结构化卡片；多选转发；输入栏（系统键盘避让）。

/// 教练 tab 根视图（MainTabView 装配；AppModel 经 environment 注入）。
public struct CoachView: View {

    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: CoachChatModel?

    public init() {}

    public var body: some View {
        Group {
            if let model {
                CoachScreen(model: model)
            } else {
                Color.clear
            }
        }
        .task {
            guard model == nil else { return }
            let chat = CoachChatModel(
                service: app.coach,
                userIdProvider: { [weak app] in app?.me?.id },
                openStrategyDraft: { [weak app] raceId, strategy in
                    app?.pendingStrategyDraft = PendingStrategyDraft(raceId: raceId, payload: strategy.payload)
                    app?.router.push(.raceStrategy(id: raceId, target: nil))
                }
            )
            model = chat
            await chat.bootstrap()
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: model?.handleSceneActive()
            case .background: model?.handleSceneBackground()
            default: break
            }
        }
        // 首页「和教练聊一聊」/ 赛事策略 CTA 移交的上下文（一次性消费）。
        .onChange(of: app.pendingCoachContext) { _, pending in
            guard let pending else { return }
            model?.consumePendingContext(pending)
        }
    }
}

// MARK: - 主屏

struct CoachScreen: View {

    @Environment(AppModel.self) private var app
    @Bindable var model: CoachChatModel

    var body: some View {
        VStack(spacing: 0) {
            topBar
            if !model.contextHint.isEmpty { contextHintBar }
            messageList
            if model.selectMode { selectBottomBar } else { inputBar }
        }
        .background(app.theme.current.background)
        .navigationTitle("教练")
        .inlineNavBarTitleIfAvailable()
        .sheet(isPresented: $model.drawerOpen) {
            CoachDrawerSheet(model: model, theme: app.theme.current)
                .presentationDetents([.medium, .large])
        }
        // 确认弹窗（master-plan 替换 / workout-op 删除双确认）。
        .alert(
            confirmTitle,
            isPresented: confirmationBinding,
            presenting: model.confirmation
        ) { _ in
            Button(confirmButtonTitle, role: confirmDestructive ? .destructive : nil) {
                Task { await model.confirmPending() }
            }
            Button("取消", role: .cancel) { model.cancelConfirmation() }
        } message: { pending in
            Text(confirmMessage(pending))
        }
        .sheet(item: $model.sharePayload) { payload in
            shareSheet(payload)
        }
        .overlay(alignment: .bottom) {
            if let toast = model.toast {
                Text(toast)
                    .font(app.theme.current.font(.fs13, weight: .medium))
                    .foregroundStyle(app.theme.current.onAccent)
                    .padding(.horizontal, app.theme.current.space(.lg))
                    .padding(.vertical, app.theme.current.space(.sm))
                    .background(app.theme.current.accentDeep, in: Capsule())
                    .padding(.bottom, 72)
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.18), value: model.toast)
    }

    // MARK: 确认弹窗文案（master-plan 替换 / workout-op 删除）

    private var confirmationBinding: Binding<Bool> {
        Binding(
            get: { model.confirmation != nil },
            set: { if !$0 { model.cancelConfirmation() } }
        )
    }

    private var confirmTitle: String {
        switch model.confirmation?.kind {
        case .replacePlan: "替换当前计划"
        case .deleteWorkout: "删除训练课"
        case nil: ""
        }
    }

    private var confirmButtonTitle: String {
        switch model.confirmation?.kind {
        case .replacePlan: "替换并应用"
        case .deleteWorkout: "删除"
        case nil: ""
        }
    }

    private var confirmDestructive: Bool {
        if case .deleteWorkout = model.confirmation?.kind { return true }
        return false
    }

    private func confirmMessage(_ pending: CoachChatModel.Confirmation) -> String {
        switch pending.kind {
        case .replacePlan(let uncertain):
            uncertain
                ? "暂时查不到你的计划状态。若已有一版启用中的训练计划，应用这版会替换它（旧计划归档）。确定应用吗？"
                : "你已有一版启用中的训练计划，应用这版会替换它（旧计划归档）。确定应用吗？"
        case .deleteWorkout(let name, let dayLabel):
            "确定删除「\(name)」（\(dayLabel)）吗？"
        }
    }

    // MARK: 顶栏（常态：汉堡/标题/搜索；多选：计数 + 取消）

    private var topBar: some View {
        HStack(spacing: app.theme.current.space(.md)) {
            if model.selectMode {
                Button("取消") { model.exitSelectMode() }
                    .font(app.theme.current.font(.fs15, weight: .medium))
                    .foregroundStyle(app.theme.current.muted)
                Spacer()
                Text("已选 \(model.selectCount) 条")
                    .font(app.theme.current.font(.fs15, weight: .bold))
                    .foregroundStyle(app.theme.current.foreground)
                Spacer()
                // 占位平衡三段布局。
                Text("取消").font(app.theme.current.font(.fs15)).hidden()
            } else {
                Button {
                    model.drawerOpen = true
                } label: {
                    Image(systemName: "line.3.horizontal")
                        .font(app.theme.current.font(.fs18, weight: .medium))
                        .foregroundStyle(app.theme.current.foreground)
                }
                Spacer()
                VStack(spacing: 2) {
                    Text("教练")
                        .font(app.theme.current.font(.fs15, weight: .bold))
                        .foregroundStyle(app.theme.current.foreground)
                    Text("AI 训练教练")
                        .font(app.theme.current.font(.fs11))
                        .foregroundStyle(app.theme.current.muted)
                }
                Spacer()
                Button {
                    model.showToast("暂未开放")
                } label: {
                    Image(systemName: "magnifyingglass")
                        .font(app.theme.current.font(.fs18, weight: .medium))
                        .foregroundStyle(app.theme.current.foreground)
                }
            }
        }
        .padding(.horizontal, app.theme.current.space(.lg))
        .padding(.vertical, app.theme.current.space(.sm))
    }

    // MARK: 上下文提示条（可关闭）

    private var contextHintBar: some View {
        HStack(spacing: app.theme.current.space(.sm)) {
            Image(systemName: "scope")
                .font(app.theme.current.font(.fs12, weight: .medium))
                .foregroundStyle(app.theme.current.accentDeep)
            Text(model.contextHint)
                .font(app.theme.current.font(.fs12, weight: .medium))
                .foregroundStyle(app.theme.current.accentDeep)
                .lineLimit(1)
            Spacer()
            Button {
                model.clearContext()
            } label: {
                Image(systemName: "xmark")
                    .font(app.theme.current.font(.fs12, weight: .medium))
                    .foregroundStyle(app.theme.current.muted)
            }
        }
        .padding(.horizontal, app.theme.current.space(.lg))
        .padding(.vertical, app.theme.current.space(.xs))
        .background(app.theme.current.accentTint)
    }

    // MARK: 消息流

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: app.theme.current.space(.lg)) {
                    ForEach(model.messages) { message in
                        CoachMessageRow(
                            model: model,
                            message: message,
                            theme: app.theme.current
                        )
                        .id("msg-\(message.id)")
                    }
                    if model.streaming {
                        CoachStreamingBubble(model: model, theme: app.theme.current)
                            .id("msg-streaming")
                    }
                }
                .padding(.horizontal, app.theme.current.space(.lg))
                .padding(.vertical, app.theme.current.space(.md))
            }
            .onChange(of: model.scrollTarget) { _, target in
                guard let target else { return }
                proxy.scrollTo(target, anchor: .bottom)
            }
            .onChange(of: model.streamTick) { _, _ in
                proxy.scrollTo("msg-streaming", anchor: .bottom)
            }
        }
    }

    // MARK: 多选底栏

    private var selectBottomBar: some View {
        HStack(spacing: app.theme.current.space(.md)) {
            Button("取消") { model.exitSelectMode() }
                .font(app.theme.current.font(.fs14, weight: .medium))
                .foregroundStyle(app.theme.current.muted)
                .frame(maxWidth: .infinity)
            Button(model.allSelected ? "取消全选" : "全选") { model.toggleSelectAll() }
                .font(app.theme.current.font(.fs14, weight: .medium))
                .foregroundStyle(app.theme.current.foreground)
                .frame(maxWidth: .infinity)
            Button {
                Task { await model.forwardSelected() }
            } label: {
                Text("转发 \(model.selectCount)")
                    .font(app.theme.current.font(.fs14, weight: .bold))
                    .foregroundStyle(app.theme.current.onAccent)
                    .padding(.horizontal, app.theme.current.space(.lg))
                    .padding(.vertical, app.theme.current.space(.xs))
                    .background(
                        model.selectCount > 0 ? app.theme.current.accent : app.theme.current.mutedTwo,
                        in: Capsule()
                    )
            }
            .disabled(model.selectCount == 0)
            .frame(maxWidth: .infinity)
        }
        .padding(.horizontal, app.theme.current.space(.lg))
        .padding(.vertical, app.theme.current.space(.sm))
        .background(app.theme.current.surface)
    }

    // MARK: 输入栏（系统键盘避让走 SwiftUI 安全区）

    private var inputBar: some View {
        HStack(alignment: .bottom, spacing: app.theme.current.space(.sm)) {
            TextField("问问教练…", text: $model.input, axis: .vertical)
                .font(app.theme.current.font(.fs14))
                .lineLimit(1...4)
                .padding(.horizontal, app.theme.current.space(.md))
                .padding(.vertical, app.theme.current.space(.sm))
                .background(app.theme.current.surface, in: Capsule())
                .overlay(Capsule().stroke(app.theme.current.borderSoft, lineWidth: 1))
                .onSubmit { Task { await model.send() } }
            Button {
                Task { await model.send() }
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 32))
                    .foregroundStyle(
                        model.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.sending
                            ? app.theme.current.mutedTwo
                            : app.theme.current.accent
                    )
            }
            .disabled(model.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.sending)
        }
        .padding(.horizontal, app.theme.current.space(.lg))
        .padding(.vertical, app.theme.current.space(.sm))
        .background(app.theme.current.background)
    }

    // MARK: 系统分享（D-share-1：单一路分享 universal link 承载）

    @ViewBuilder
    private func shareSheet(_ payload: CoachChatModel.SharePayload) -> some View {
        #if canImport(UIKit)
        ActivityShareSheet(items: [payload.title, payload.url])
        #else
        VStack(spacing: 12) {
            Text(payload.title)
            Text(payload.url.absoluteString)
                .font(.system(.caption, design: .monospaced))
        }
        .padding()
        #endif
    }
}

// MARK: - 消息行

struct CoachMessageRow: View {

    let model: CoachChatModel
    let message: CoachMessage
    let theme: any Theme

    var body: some View {
        HStack(alignment: .top, spacing: theme.space(.sm)) {
            if model.selectMode {
                selectionToggle
            }
            if message.role == .user { Spacer(minLength: theme.space(.sm)) }
            VStack(alignment: message.role == .user ? .trailing : .leading, spacing: theme.space(.xs)) {
                bubble
                footer
            }
        }
        .contentShape(Rectangle())
        .onTapGesture {
            model.handleMessageTap(message.id)
        }
        .onLongPressGesture {
            model.handleMessageLongPress(message.id)
        }
    }

    private var selectionToggle: some View {
        ZStack {
            Circle()
                .stroke(message.selected ? theme.accent : theme.border, lineWidth: 1.5)
                .frame(width: 22, height: 22)
            if message.selected {
                Circle().fill(theme.accent).frame(width: 22, height: 22)
                Image(systemName: "checkmark")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(theme.onAccent)
            }
        }
        .opacity(message.selectable ? 1 : 0.35)
        .padding(.top, theme.space(.xs))
    }

    @ViewBuilder
    private var bubble: some View {
        VStack(alignment: .leading, spacing: theme.space(.sm)) {
            if let card = message.card {
                CoachCardView(card: card, theme: theme) {
                    model.openCard(messageId: message.id)
                } primaryAction: {
                    Task { await model.cardPrimaryAction(messageId: message.id) }
                } secondaryAction: {
                    Task { await model.cardSecondaryAction(messageId: message.id) }
                }
                // 摘要即卡片的产物（master-plan / custom-workout）：正文摘要渲染在卡片下方。
                if card.inlineBody, !message.content.isEmpty {
                    MarkdownContent(markdown: message.content, theme: theme)
                }
            } else {
                MarkdownContent(markdown: message.content, theme: theme)
            }
            if let ts = message.ts {
                Text(ts)
                    .font(theme.font(.fs10))
                    .foregroundStyle(theme.mutedTwo)
            }
        }
        .padding(.horizontal, theme.space(.md))
        .padding(.vertical, theme.space(.sm))
        .background(
            message.role == .user
                ? theme.accent
                : (message.failed ? theme.background : theme.surface),
            in: RoundedRectangle(cornerRadius: theme.radius(.lg))
        )
        .overlay(alignment: .topLeading) {
            if message.role == .assistant && !model.selectMode {
                RoundedRectangle(cornerRadius: theme.radius(.lg))
                    .stroke(theme.borderSoft, lineWidth: 1)
            } else {
                EmptyView()
            }
        }
        .foregroundStyle(message.role == .user ? theme.onAccent : theme.foreground)
        .frame(maxWidth: 520, alignment: message.role == .user ? .trailing : .leading)
    }

    /// 气泡下方操作行：失败重试（user）/ 常驻复制（assistant，卡片消息除外）。
    @ViewBuilder
    private var footer: some View {
        HStack(spacing: theme.space(.sm)) {
            if message.failed && !model.selectMode {
                Button {
                    Task { await model.retry(messageId: message.id) }
                } label: {
                    Label("重试", systemImage: "arrow.clockwise")
                        .font(theme.font(.fs12, weight: .medium))
                        .foregroundStyle(theme.danger)
                }
            }
            if message.role == .assistant && message.card == nil && !model.selectMode {
                Button {
                    _ = model.copyMessageText(message.id)
                } label: {
                    Label("复制", systemImage: "doc.on.doc")
                        .font(theme.font(.fs12, weight: .medium))
                        .foregroundStyle(theme.muted)
                }
            }
        }
    }
}

// MARK: - 流式气泡

struct CoachStreamingBubble: View {

    let model: CoachChatModel
    let theme: any Theme

    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: theme.space(.xs)) {
                if !model.streamPhase.isEmpty && model.streamText.isEmpty {
                    HStack(spacing: theme.space(.xs)) {
                        ProgressView().controlSizeIfAvailable(.small)
                        Text(model.streamPhase)
                            .font(theme.font(.fs13))
                            .foregroundStyle(theme.muted)
                    }
                }
                if !model.streamNarration.isEmpty {
                    Text(model.streamNarration)
                        .font(theme.font(.fs12))
                        .foregroundStyle(theme.mutedTwo)
                }
                if !model.streamText.isEmpty {
                    // 打字机：呈现层文本（JSON 泄漏时已被换成「正在整理内容…」）+ 光标。
                    HStack(alignment: .bottom, spacing: 2) {
                        Text(model.streamText)
                            .font(theme.font(.fs14))
                            .foregroundStyle(theme.foreground)
                        Rectangle()
                            .fill(theme.accent)
                            .frame(width: 2, height: 16)
                            .blink
                    }
                }
                if model.streamText.isEmpty && model.streamNarration.isEmpty && model.streamPhase.isEmpty {
                    HStack(spacing: theme.space(.xs)) {
                        Text("正在思考…")
                            .font(theme.font(.fs13))
                            .foregroundStyle(theme.muted)
                    }
                }
            }
            .padding(.horizontal, theme.space(.md))
            .padding(.vertical, theme.space(.sm))
            .background(theme.surface, in: RoundedRectangle(cornerRadius: theme.radius(.lg)))
            .overlay(
                RoundedRectangle(cornerRadius: theme.radius(.lg)).stroke(theme.borderSoft, lineWidth: 1)
            )
            Spacer(minLength: theme.space(.lg))
        }
    }
}

// MARK: - 结构化卡片

struct CoachCardView: View {

    let card: CoachCardRegistry.View
    let theme: any Theme
    let onOpen: () -> Void
    let primaryAction: () -> Void
    let secondaryAction: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space(.sm)) {
            HStack(spacing: theme.space(.sm)) {
                Image(systemName: card.icon)
                    .font(theme.font(.fs15, weight: .medium))
                    .foregroundStyle(theme.accentDeep)
                Text(card.title)
                    .font(theme.font(.fs14, weight: .bold))
                    .foregroundStyle(theme.foreground)
                Spacer()
                if !card.badge.isEmpty {
                    Text(card.badge)
                        .font(theme.font(.fs10, weight: .medium))
                        .foregroundStyle(theme.accentDeep)
                        .padding(.horizontal, theme.space(.sm))
                        .padding(.vertical, 2)
                        .background(theme.accentTint, in: Capsule())
                }
            }
            Text(card.subtitle)
                .font(theme.font(.fs13))
                .foregroundStyle(theme.muted)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: theme.space(.sm)) {
                if !card.buttonText.isEmpty {
                    Button(action: primaryAction) {
                        Text(card.buttonText)
                            .font(theme.font(.fs13, weight: .bold))
                            .foregroundStyle(theme.onAccent)
                            .padding(.horizontal, theme.space(.lg))
                            .padding(.vertical, theme.space(.xs))
                            .background(theme.accent, in: Capsule())
                    }
                }
                if !card.secondaryButtonText.isEmpty {
                    Button(action: secondaryAction) {
                        Text(card.secondaryButtonText)
                            .font(theme.font(.fs13, weight: .medium))
                            .foregroundStyle(theme.accentDeep)
                            .padding(.horizontal, theme.space(.lg))
                            .padding(.vertical, theme.space(.xs))
                            .background(theme.accentTint, in: Capsule())
                    }
                }
                Spacer()
            }
        }
        .padding(theme.space(.md))
        .background(theme.accentTint.opacity(0.4), in: RoundedRectangle(cornerRadius: theme.radius(.md)))
        .overlay(
            RoundedRectangle(cornerRadius: theme.radius(.md)).stroke(theme.borderSoft, lineWidth: 1)
        )
        .contentShape(Rectangle())
        .onTapGesture {
            if card.navigable { onOpen() }
        }
    }
}

// MARK: - 会话抽屉（底部 sheet）

struct CoachDrawerSheet: View {

    @Bindable var model: CoachChatModel
    let theme: any Theme

    var body: some View {
        VStack(spacing: theme.space(.md)) {
            Capsule()
                .fill(theme.border)
                .frame(width: 36, height: 4)
                .padding(.top, theme.space(.sm))
            HStack {
                Text("会话")
                    .font(theme.font(.fs15, weight: .bold))
                    .foregroundStyle(theme.foreground)
                Spacer()
                Image(systemName: "magnifyingglass")
                    .font(theme.font(.fs14, weight: .medium))
                    .foregroundStyle(theme.mutedTwo)
            }
            .padding(.horizontal, theme.space(.lg))
            Button {
                model.newConversation()
            } label: {
                Label("新建对话", systemImage: "plus.circle.fill")
                    .font(theme.font(.fs14, weight: .bold))
                    .foregroundStyle(theme.accentDeep)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, theme.space(.sm))
                    .background(theme.accentTint, in: RoundedRectangle(cornerRadius: theme.radius(.md)))
            }
            .padding(.horizontal, theme.space(.lg))
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(model.sessions) { session in
                        Button {
                            model.selectSession(session.id)
                        } label: {
                            HStack(spacing: theme.space(.sm)) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(session.title)
                                        .font(theme.font(.fs14, weight: .medium))
                                        .foregroundStyle(theme.foreground)
                                        .lineLimit(2)
                                    if let label = session.contextLabel, !label.isEmpty {
                                        Text(label)
                                            .font(theme.font(.fs11))
                                            .foregroundStyle(theme.mutedTwo)
                                            .lineLimit(1)
                                    }
                                }
                                Spacer()
                                if session.id == model.currentSessionId {
                                    Text("当前")
                                        .font(theme.font(.fs10, weight: .medium))
                                        .foregroundStyle(theme.onAccent)
                                        .padding(.horizontal, theme.space(.sm))
                                        .padding(.vertical, 2)
                                        .background(theme.accent, in: Capsule())
                                }
                            }
                            .padding(.horizontal, theme.space(.lg))
                            .padding(.vertical, theme.space(.sm))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .background(theme.background)
    }
}

// MARK: - Markdown（GFM 子集，零三方依赖）

/// 轻量 markdown 块渲染：标题/段落/无序有序列表/引用/围栏代码/表格；
/// 行内（粗体/斜体/代码/链接）交给 AttributedString inline 模式。
/// mp-html 全量 GFM 的对等渲染归 PR-10 parity 核对统一裁定。
struct MarkdownContent: View {

    let markdown: String
    let theme: any Theme

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space(.sm)) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
    }

    // MARK: 块解析

    enum Block {
        case heading(level: Int, text: String)
        case paragraph(String)
        case bullets([String])
        case ordered([String])
        case quote(String)
        case code(String)
        case table(header: [String], rows: [[String]])
    }

    var blocks: [Block] {
        var result: [Block] = []
        let lines = markdown.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var index = 0
        var paragraphBuffer: [String] = []

        func flushParagraph() {
            guard !paragraphBuffer.isEmpty else { return }
            result.append(.paragraph(paragraphBuffer.joined(separator: "\n")))
            paragraphBuffer = []
        }

        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                flushParagraph()
                var codeLines: [String] = []
                index += 1
                while index < lines.count, !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    codeLines.append(lines[index])
                    index += 1
                }
                result.append(.code(codeLines.joined(separator: "\n")))
                index += 1
                continue
            }
            if trimmed.isEmpty {
                flushParagraph()
                index += 1
                continue
            }
            if let heading = parseHeading(trimmed) {
                flushParagraph()
                result.append(.heading(level: heading.0, text: heading.1))
                index += 1
                continue
            }
            if trimmed.hasPrefix("> ") || trimmed == ">" {
                flushParagraph()
                var quoteLines: [String] = []
                while index < lines.count {
                    let q = lines[index].trimmingCharacters(in: .whitespaces)
                    if q.hasPrefix(">") {
                        quoteLines.append(String(q.dropFirst()).trimmingCharacters(in: .whitespaces))
                        index += 1
                    } else { break }
                }
                result.append(.quote(quoteLines.joined(separator: "\n")))
                continue
            }
            if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") {
                flushParagraph()
                var items: [String] = []
                while index < lines.count {
                    let item = lines[index].trimmingCharacters(in: .whitespaces)
                    if item.hasPrefix("- ") || item.hasPrefix("* ") {
                        items.append(String(item.dropFirst(2)))
                        index += 1
                    } else { break }
                }
                result.append(.bullets(items))
                continue
            }
            if isOrderedItem(trimmed) {
                flushParagraph()
                var items: [String] = []
                while index < lines.count {
                    let item = lines[index].trimmingCharacters(in: .whitespaces)
                    if let text = orderedItemText(item) {
                        items.append(text)
                        index += 1
                    } else { break }
                }
                result.append(.ordered(items))
                continue
            }
            if trimmed.hasPrefix("|"), index + 1 < lines.count,
               lines[index + 1].contains("---"), lines[index + 1].hasPrefix("|") {
                flushParagraph()
                let header = tableCells(trimmed)
                index += 2
                var rows: [[String]] = []
                while index < lines.count, lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("|") {
                    rows.append(tableCells(lines[index]))
                    index += 1
                }
                result.append(.table(header: header, rows: rows))
                continue
            }
            paragraphBuffer.append(line)
            index += 1
        }
        flushParagraph()
        return result
    }

    private func parseHeading(_ line: String) -> (Int, String)? {
        guard let firstHash = line.firstIndex(where: { $0 != "#" }) else { return nil }
        let level = line.distance(from: line.startIndex, to: firstHash)
        guard (1...6).contains(level) else { return nil }
        let text = String(line.dropFirst(level)).trimmingCharacters(in: .whitespaces)
        return (level, text)
    }

    private func isOrderedItem(_ line: String) -> Bool {
        orderedItemText(line) != nil
    }

    private func orderedItemText(_ line: String) -> String? {
        guard let dot = line.firstIndex(of: "."),
              dot != line.startIndex,
              line[..<dot].allSatisfy(\.isNumber)
        else { return nil }
        return String(line[line.index(after: dot)...]).trimmingCharacters(in: .whitespaces)
    }

    private func tableCells(_ line: String) -> [String] {
        line.split(separator: "|", omittingEmptySubsequences: true).map { $0.trimmingCharacters(in: .whitespaces) }
    }

    // MARK: 块渲染

    @ViewBuilder
    private func blockView(_ block: Block) -> some View {
        switch block {
        case .heading(let level, let text):
            inlineText(text)
                .font(theme.font(headingFont(level), weight: .bold))
                .foregroundStyle(theme.foreground)
        case .paragraph(let text):
            inlineText(text)
                .font(theme.font(.fs14))
                .foregroundStyle(theme.foreground)
        case .bullets(let items):
            VStack(alignment: .leading, spacing: theme.space(.xs)) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: theme.space(.sm)) {
                        Circle().fill(theme.mutedTwo).frame(width: 4, height: 4)
                        inlineText(item)
                            .font(theme.font(.fs14))
                            .foregroundStyle(theme.foreground)
                    }
                }
            }
        case .ordered(let items):
            VStack(alignment: .leading, spacing: theme.space(.xs)) {
                ForEach(Array(items.enumerated()), id: \.offset) { number, item in
                    HStack(alignment: .firstTextBaseline, spacing: theme.space(.sm)) {
                        Text("\(number + 1).")
                            .font(theme.font(.fs14, weight: .medium))
                            .foregroundStyle(theme.muted)
                        inlineText(item)
                            .font(theme.font(.fs14))
                            .foregroundStyle(theme.foreground)
                    }
                }
            }
        case .quote(let text):
            inlineText(text)
                .font(theme.font(.fs13))
                .foregroundStyle(theme.muted)
                .padding(.leading, theme.space(.sm))
                .overlay(alignment: .leading) {
                    Rectangle().fill(theme.border).frame(width: 3)
                }
        case .code(let text):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    .font(theme.font(.fs13, weight: .regular, mono: true))
                    .foregroundStyle(theme.foreground)
            }
            .padding(theme.space(.sm))
            .background(theme.surface, in: RoundedRectangle(cornerRadius: theme.radius(.sm)))
        case .table(let header, let rows):
            VStack(alignment: .leading, spacing: 0) {
                tableRow(header, weight: .bold)
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    Divider().overlay(theme.borderSoft)
                    tableRow(row, weight: .regular)
                }
            }
            .overlay(RoundedRectangle(cornerRadius: theme.radius(.sm)).stroke(theme.borderSoft, lineWidth: 1))
        }
    }

    private func tableRow(_ cells: [String], weight: GeistWeight) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            ForEach(Array(cells.enumerated()), id: \.offset) { _, cell in
                inlineText(cell)
                    .font(theme.font(.fs12, weight: weight))
                    .foregroundStyle(theme.foreground)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 4)
                    .padding(.horizontal, theme.space(.xs))
            }
        }
    }

    private func headingFont(_ level: Int) -> FontScale {
        switch level {
        case 1: .fs20
        case 2: .fs18
        case 3: .fs15
        default: .fs14
        }
    }

    /// 行内 markdown（粗体/斜体/代码/链接）；解析失败回退纯文本。
    @ViewBuilder
    private func inlineText(_ text: String) -> some View {
        if let attributed = try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            Text(attributed)
        } else {
            Text(text)
        }
    }
}

// MARK: - 小组件

#if canImport(UIKit)
/// 系统分享面板（UIActivityViewController 的 SwiftUI 封装）。
struct ActivityShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
#endif

// MARK: - 平台差异修饰符收敛（macOS swift test 可编译）

extension View {
    /// iOS 上锁 inline 标题形态；macOS 无该概念直接返回。
    @ViewBuilder
    func inlineNavBarTitleIfAvailable() -> some View {
        #if canImport(UIKit)
        self.navigationBarTitleDisplayMode(.inline)
        #else
        self
        #endif
    }

    @ViewBuilder
    func controlSizeIfAvailable(_ size: ControlSize) -> some View {
        #if canImport(UIKit)
        self.controlSize(size)
        #else
        self
        #endif
    }
}

extension View {
    /// 打字机光标呼吸。
    var blink: some View {
        modifier(BlinkModifier())
    }
}

struct BlinkModifier: ViewModifier {
    @State private var visible = true

    func body(content: Content) -> some View {
        content
            .opacity(visible ? 1 : 0.15)
            .task {
                while !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(500))
                    visible.toggle()
                }
            }
    }
}
