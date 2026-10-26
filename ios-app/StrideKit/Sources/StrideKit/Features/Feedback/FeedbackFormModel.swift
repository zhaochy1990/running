import Foundation
import Observation

// 提交反馈表单 ViewModel（devops#554，PR-7 收尾域 devops#770）：
// 类型分段联动占位 / 0-9 张图（>10MB 跳过 toast）/ 两段式提交（任一张上传
// 失败即中止，保留本地图可重试）；client_version=ios/{version} 由 services
// 层静默注入（页面零展示）。

/// 单张上限（与后端 feedbackImageMaxBytes 一致）。
public let feedbackImageMaxBytes = 10 * 1024 * 1024
public let feedbackMaxImages = 9

@MainActor
@Observable
public final class FeedbackFormModel {

    public struct Pic: Equatable, Identifiable, Sendable {
        public let id: UUID
        public let data: Data

        public init(id: UUID = UUID(), data: Data) {
            self.id = id
            self.data = data
        }
    }

    public static let typeDefs: [(type: FeedbackType, label: String, placeholder: String)] = [
        (.bug, "🐞 Bug 反馈", "遇到了什么问题？什么操作触发的？"),
        (.suggestion, "💡 产品建议", "想让我们做什么？为什么？"),
    ]

    public private(set) var type: FeedbackType = .bug
    public var placeholder: String { Self.typeDefs.first { $0.type == type }?.placeholder ?? "" }
    public var typeLabel: String { Self.typeDefs.first { $0.type == type }?.label ?? "" }

    public var content = ""
    public private(set) var pics: [Pic] = []
    public private(set) var submitting = false
    public internal(set) var toastMessage: String?

    public var canSubmit: Bool {
        !submitting && !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public internal(set) var submitted = false

    private var app: AppModel?
    private var started = false

    public init() {}

    public func activate(app: AppModel) async {
        self.app = app
        guard !started else { return }
        started = true
        await app.waitUntilSessionSettled()
    }

    public func switchType(_ type: FeedbackType) {
        guard type != self.type else { return }
        self.type = type
    }

    /// 加图（PhotosPicker 多选）：超 10MB 的跳过 + toast；总数夹在 9。
    public func addPics(_ payloads: [Data]) async {
        let remain = feedbackMaxImages - pics.count
        guard remain > 0 else { return }
        let oversize = payloads.filter { $0.count > feedbackImageMaxBytes }
        let ok = payloads.filter { $0.count <= feedbackImageMaxBytes }
        if !oversize.isEmpty {
            toastMessage = "\(oversize.count) 张图超过 10MB，已跳过"
        }
        if !ok.isEmpty {
            pics += ok.prefix(remain).map { Pic(data: $0) }
        }
    }

    public func deletePic(at id: UUID) {
        pics.removeAll { $0.id == id }
    }

    /// 两段式提交：逐张 POST /feedback-images 拿 cos_key（任一失败即中止，
    /// 保留本地图让用户重试）→ POST /feedbacks。
    public func submit() async {
        guard canSubmit else { return }
        submitting = true
        defer { submitting = false }
        do {
            var keys: [String] = []
            for pic in pics {
                keys.append(try await app?.api.uploadFeedbackImage(pic.data) ?? "")
            }
            try await app?.api.submitFeedback(
                type: type,
                content: content.trimmingCharacters(in: .whitespacesAndNewlines),
                images: keys.filter { !$0.isEmpty }
            )
            submitted = true
            toastMessage = "已提交 · 我们会尽快回复"
        } catch {
            let message = (error as? ApiError)?.message ?? "提交失败"
            toastMessage = message.count > 15 ? "提交失败，请重试" : message
        }
    }
}
