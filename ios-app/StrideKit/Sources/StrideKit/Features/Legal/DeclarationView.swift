import SwiftUI

/// 声明正文公开页（PR-2 登录域，baseline §1.3 直译）：`GET /api/declarations/
/// {docType}` 免登录拉取，markdown 渲染（`MarkdownText`，mp-html 的
/// SwiftUI 方案，mapping.md 转译约定）。404 =「该声明尚未发布」。
public struct DeclarationView: View {

    @Environment(AppModel.self) private var model
    @State private var doc: DeclarationDoc?
    @State private var failedStatus: Int?

    let docType: DeclarationType

    public init(docType: DeclarationType) {
        self.docType = docType
    }

    public var body: some View {
        let theme = model.theme.current
        Group {
            if let doc {
                ScrollView {
                    MarkdownText(doc.contentMarkdown, theme: theme)
                        .padding(theme.space(.lg))
                }
            } else if let failedStatus {
                VStack(spacing: theme.space(.md)) {
                    Text(failedStatus == 404 ? "该声明尚未发布" : "加载失败")
                        .font(theme.font(.fs14))
                        .foregroundStyle(theme.muted)
                    Button("重试") {
                        Task { await load() }
                    }
                    .font(theme.font(.fs14, weight: .medium))
                    .foregroundStyle(theme.accentDeep)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(theme.background)
        .navigationTitle(doc?.title ?? defaultTitle)
        .task(id: docType) { await load() }
    }

    private var defaultTitle: String {
        docType == .privacyPolicy ? "隐私政策" : "用户协议"
    }

    private func load() async {
        failedStatus = nil
        do {
            doc = try await model.api.declaration(docType)
        } catch let error as ApiError {
            failedStatus = error.statusCode
        } catch {
            failedStatus = -1
        }
    }
}

/// 隐私与权限聚合页（baseline §1.4 直译）：两行菜单（用户协议 / 隐私政策，
/// icon + 标题 + 副标题），点击 push 对应声明页；纯静态行、无端点。
public struct PrivacyView: View {

    @Environment(AppModel.self) private var model

    private struct Row {
        let type: DeclarationType
        let title: String
        let subtitle: String
        let icon: String

        static let all: [Row] = [
            Row(type: .userAgreement, title: "用户协议", subtitle: "服务条款与用户权利义务", icon: "checkmark.seal"),
            Row(type: .privacyPolicy, title: "隐私政策", subtitle: "数据收集与使用说明", icon: "hand.raised"),
        ]
    }

    public init() {}

    public var body: some View {
        let theme = model.theme.current
        ScrollView {
            VStack(spacing: 0) {
                ForEach(Row.all, id: \.type) { row in
                    Button {
                        model.router.push(.declaration(docType: row.type))
                    } label: {
                        HStack(spacing: theme.space(.md)) {
                            Image(systemName: row.icon)
                                .foregroundStyle(theme.accent)
                                .frame(width: 24)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(row.title)
                                    .font(theme.font(.fs15))
                                    .foregroundStyle(theme.foreground)
                                Text(row.subtitle)
                                    .font(theme.font(.fs12))
                                    .foregroundStyle(theme.muted)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(theme.font(.fs12))
                                .foregroundStyle(theme.mutedTwo)
                        }
                        .padding(theme.space(.lg))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if row.type != Row.all.last?.type {
                        Divider().overlay(theme.borderSoft).padding(.leading, theme.space(.xxxl))
                    }
                }
            }
            .background(RoundedRectangle(cornerRadius: theme.radius(.md)).fill(theme.surface))
            .clipShape(RoundedRectangle(cornerRadius: theme.radius(.md)))
            .padding(theme.space(.lg))
        }
        .background(theme.background)
        .navigationTitle("隐私与权限")
    }
}
