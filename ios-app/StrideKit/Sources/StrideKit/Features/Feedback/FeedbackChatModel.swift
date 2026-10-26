import Foundation
import Observation

// 反馈线程聊天 ViewModel（devops#554，PR-7 收尾域 devops#770）：
// 进入即 GET /feedbacks/{id}——服务端读即清官方回复未读（红点清零的服务端
// 真相）；409 feedback_closed → 前端同步置禁言态；已采纳横幅的关联标题从
// GET /api/roadmap 反查（失败不阻塞仅隐藏）。

@MainActor
@Observable
public final class FeedbackChatModel {

    public struct Bubble: Equatable, Identifiable, Sendable {
        public let id: Int
        public let mine: Bool
        public let text: String
        public let time: String
    }

    public struct Head: Equatable, Sendable {
        public let typeLabel: String
        public let typeEmoji: String
        public let statusLabel: String
        public let adopted: Bool
    }

    public private(set) var loading = true
    public private(set) var loadError = ""

    public private(set) var head = Head(typeLabel: "Bug 反馈", typeEmoji: "🐞", statusLabel: "待处理", adopted: false)
    public private(set) var content = ""
    public private(set) var imageUrls: [String] = []
    public private(set) var time = ""
    /// 已采纳关联的产品路线标题；空串 = 隐藏横幅标题段。
    public private(set) var adoptedTitle = ""
    public private(set) var bubbles: [Bubble] = []
    public private(set) var closed = false

    public var draft = ""
    public private(set) var sending = false
    public internal(set) var toastMessage: String?

    public var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !closed && !sending
    }

    private let feedbackId: Int
    private var app: AppModel?
    private var fetchSeq = 0

    public init(feedbackId: Int) {
        self.feedbackId = feedbackId
    }

    public func activate(app: AppModel) async {
        self.app = app
        await app.waitUntilSessionSettled()
        await fetchThread()
    }

    public func fetchThread() async {
        guard let app else { return }
        guard feedbackId > 0 else {
            loading = false
            loadError = "会话不存在"
            return
        }
        let seq = fetchSeq + 1
        fetchSeq = seq
        if bubbles.isEmpty { loading = true }
        do {
            // adopted 标题反查；路线图拉不到不阻塞线程展示。
            async let roadmap = try? app.api.roadmap()
            let detail = try await app.api.feedbackDetail(id: feedbackId)
            let roadmapResult = await roadmap
            guard seq == fetchSeq else { return }

            let fb = detail.feedback
            head = Head(
                typeLabel: fb.type == .bug ? "Bug 反馈" : "产品建议",
                typeEmoji: fb.type == .bug ? "🐞" : "💡",
                statusLabel: Self.statusLabel(fb.status),
                adopted: fb.adoptedFeatureId != nil
            )
            content = fb.content
            imageUrls = fb.imageUrls
            let now = Date()
            time = feedbackTimeLabel(fb.createdAt, now: now)
            bubbles = detail.replies.map { reply in
                Bubble(
                    id: reply.id,
                    mine: reply.author == "user",
                    text: reply.content,
                    time: feedbackTimeLabel(reply.createdAt, now: now)
                )
            }
            if let adoptedId = fb.adoptedFeatureId, let roadmap = roadmapResult {
                let titles = Dictionary(
                    roadmap.backlog.map { ($0.id, $0.title) }
                        + roadmap.accepted.map { ($0.id, $0.title) }
                        + roadmap.released.map { ($0.id, $0.title) },
                    uniquingKeysWith: { first, _ in first }
                )
                adoptedTitle = titles[adoptedId] ?? ""
            }
            closed = fb.status == .closed
            loading = false
            loadError = ""
        } catch {
            guard seq == fetchSeq else { return }
            loading = false
            let message = (error as? ApiError)?.message ?? "加载失败"
            loadError = message.count > 20 ? "加载失败" : message
        }
    }

    private static func statusLabel(_ status: FeedbackStatus) -> String {
        switch status {
        case .open: "待处理"
        case .replied: "已回复"
        case .closed: "已关闭"
        }
    }

    // MARK: - 追问

    public func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !closed, !sending, let app else { return }
        sending = true
        defer { sending = false }
        do {
            let reply = try await app.api.replyFeedback(id: feedbackId, content: text)
            bubbles.append(Bubble(
                id: reply.id,
                mine: reply.author == "user",
                text: reply.content,
                time: feedbackTimeLabel(reply.createdAt, now: Date())
            ))
            draft = ""
        } catch let error as ApiError {
            if error.statusCode == 409 || error.code == "feedback_closed" {
                // 前端同步禁言态（feedback-chat.ts 同款）。
                closed = true
                toastMessage = "该反馈已关闭，如有问题请提交新反馈"
            } else {
                toastMessage = "发送失败，请重试"
            }
        } catch {
            toastMessage = "发送失败，请重试"
        }
    }
}
